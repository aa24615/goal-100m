// 交易服务层：承载买卖成交、T+1 冻结、涨跌停校验等核心业务逻辑。
// 与 HTTP 无关，便于在集成测试中直接驱动；路由层只负责参数解析与鉴权。

import pool from '../db.js';
import { getDetail, addTradeVolume } from '../market.js';
import { logger } from '../logger.js';
import { calcFees, T1_ENABLED, PRICE_TOLERANCE } from '../fees.js';
import { shToday, dateStrOf } from '../utils/time.js';

// 可卖数量：T+1 下当日买入部分冻结
export function availableQty(row) {
  const qty = row.quantity;
  if (!T1_ENABLED) return qty;
  const frozen = dateStrOf(row.last_buy_date) === shToday() ? row.t1_qty || 0 : 0;
  return Math.max(0, qty - frozen);
}

export function tradeError(message, status, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra || {};
  e.expose = true; // 业务错误：允许透传消息给前端（区别于 body-parser 等底层 4xx）
  e.business = true; // 与 businessError 同义，便于日志区分业务拒绝与报文非法
  return e;
}

/**
 * 成交核心：市价单与限价单撮合共用同一套逻辑
 * - 资金/持仓校验、行锁、成本价含费、已实现盈亏、成交量回写
 * - 业务失败抛出带 status 的错误，由调用方决定如何返回
 */
export async function executeTrade({ uid, code, type, quantity, price, stockName }) {
  const amount = Math.round(price * quantity * 100) / 100;
  const fee = calcFees(amount, type);
  const today = shToday();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT cash FROM users WHERE id=$1 FOR UPDATE', [uid]);
    if (!u.rows[0]) {
      await client.query('ROLLBACK').catch(() => {});
      logger.warn('交易失败: 用户不存在', { userId: uid });
      throw tradeError('用户不存在', 404);
    }
    const cash = Number(u.rows[0].cash);

    if (type === 'BUY') {
      const total = amount + fee;
      if (total > cash) {
        const need = Math.round(total * 100) / 100;
        await client.query('ROLLBACK').catch(() => {});
        logger.warn('买入失败: 可用资金不足', {
          userId: uid,
          code,
          quantity,
          need,
          cash,
        });
        // F-31：只回一句「可用资金不足」时，用户看到的「可用」与库里不一致却无从判断，
        // 只能反复试数量（2026-10-29 连试 472800→472700→472000 三次）。
        // 把服务端权威的 need/cash/shortfall 一起下发，让前端能直接说出差多少。
        throw tradeError('可用资金不足', 400, {
          need,
          cash,
          shortfall: Math.round((need - cash) * 100) / 100,
          code,
          quantity,
          price,
        });
      }
      await client.query('UPDATE users SET cash = cash - $1 WHERE id=$2', [total, uid]);

      // 行锁：避免并发加仓导致数量/成本价竞态
      const h = await client.query(
        'SELECT * FROM holdings WHERE user_id=$1 AND stock_code=$2 FOR UPDATE',
        [uid, code]
      );
      if (h.rows.length === 0) {
        // 建仓成本价含买入费用
        const avg = Math.round(((amount + fee) / quantity) * 10000) / 10000;
        await client.query(
          'INSERT INTO holdings (user_id, stock_code, quantity, avg_cost, t1_qty, last_buy_date) VALUES ($1, $2, $3, $4, $5, $6)',
          [uid, code, quantity, avg, T1_ENABLED ? quantity : 0, today]
        );
      } else {
        const r = h.rows[0];
        const newQty = r.quantity + quantity;
        // 加仓：费用一并摊入成本
        const newAvg =
          Math.round(((r.quantity * Number(r.avg_cost) + amount + fee) / newQty) * 10000) / 10000;
        const prevFrozen = dateStrOf(r.last_buy_date) === today ? r.t1_qty || 0 : 0;
        await client.query(
          'UPDATE holdings SET quantity=$1, avg_cost=$2, t1_qty=$3, last_buy_date=$4, updated_at=now() WHERE id=$5',
          [newQty, newAvg, prevFrozen + (T1_ENABLED ? quantity : 0), today, r.id]
        );
      }
      await client.query(
        `INSERT INTO transactions (user_id, stock_code, stock_name, type, quantity, price, amount, fee, realized_pnl, cash_after, holding_qty_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uid,
          code,
          stockName,
          type,
          quantity,
          price,
          amount,
          fee,
          0,
          Math.round((cash - total) * 100) / 100,
          (h.rows[0]?.quantity || 0) + quantity,
        ]
      );
    } else {
      // 行锁：防止并发超卖
      const h = await client.query(
        'SELECT * FROM holdings WHERE user_id=$1 AND stock_code=$2 FOR UPDATE',
        [uid, code]
      );
      if (h.rows.length === 0 || h.rows[0].quantity < quantity) {
        await client.query('ROLLBACK').catch(() => {});
        logger.warn('卖出失败: 可用持仓不足', {
          userId: uid,
          want: quantity,
          hold: h.rows[0]?.quantity ?? 0,
        });
        throw tradeError('可用持仓不足', 400, {
          want: quantity,
          hold: h.rows[0]?.quantity ?? 0,
          code,
        });
      }
      const r = h.rows[0];
      const sellable = availableQty(r);
      if (quantity > sellable) {
        await client.query('ROLLBACK').catch(() => {});
        logger.warn('卖出失败: T+1 当日买入不可卖', {
          userId: uid,
          code,
          want: quantity,
          sellable,
          frozen: r.t1_qty || 0,
        });
        throw tradeError(
          T1_ENABLED
            ? `当日买入的 ${r.t1_qty || 0} 股处于 T+1 冻结，当前可卖 ${sellable} 股`
            : '可用持仓不足',
          400,
          { want: quantity, sellable, frozen: r.t1_qty || 0, code }
        );
      }
      const newQty = r.quantity - quantity;
      const avgCost = Number(r.avg_cost);
      // 已实现盈亏 = (卖出价 - 摊薄成本) × 数量 - 费用
      const realized = Math.round(((price - avgCost) * quantity - fee) * 100) / 100;
      const frozen = dateStrOf(r.last_buy_date) === today ? r.t1_qty || 0 : 0;
      const newFrozen = Math.max(0, frozen - quantity);

      if (newQty === 0) {
        await client.query('DELETE FROM holdings WHERE id=$1', [r.id]);
      } else {
        await client.query(
          'UPDATE holdings SET quantity=$1, t1_qty=$2, updated_at=now() WHERE id=$3',
          [newQty, newFrozen, r.id]
        );
      }
      await client.query('UPDATE users SET cash = cash + $1 WHERE id=$2', [amount - fee, uid]);
      await client.query(
        `INSERT INTO transactions (user_id, stock_code, stock_name, type, quantity, price, amount, fee, realized_pnl, cash_after, holding_qty_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uid,
          code,
          stockName,
          type,
          quantity,
          price,
          amount,
          fee,
          realized,
          Math.round((cash + amount - fee) * 100) / 100,
          newQty,
        ]
      );
    }

    await client.query('COMMIT');
    // 成交量与成交额由真实成交驱动（量价不再背离）
    addTradeVolume(code, quantity, amount);
    logger.info('交易成功', { userId: uid, type, code, quantity, price, amount, fee });
    return { ok: true, type, code, quantity, price, amount, fee };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e.status) throw e; // 业务失败：已在上面 warn，不再记 error
    logger.error('交易异常: 数据库错误', { userId: uid, code, type, quantity, err: e });
    throw e;
  } finally {
    client.release();
  }
}

// 涨跌停与报价保护校验（市价下单前）
export function validateOrder({ type, price, limitUp, limitDown, clientPrice }) {
  if (Number.isFinite(clientPrice) && clientPrice > 0) {
    const dev = Math.abs(price - clientPrice) / clientPrice;
    if (dev > PRICE_TOLERANCE) {
      return tradeError('行情已变动，请确认最新价后重试', 409, {
        latestPrice: price,
        clientPrice,
      });
    }
  }
  // 无涨跌幅限制（新股上市前 N 日 / 昨收缺失）时 limitUp/Down 为 null：必须显式跳过，
  // 否则 `price >= null * 0.999`（即 >= 0）恒真，所有买单都会被误判为「已涨停」——
  // 规则放开反而变成全面拒单，与 RQ-49 的意图正好相反。
  if (Number.isFinite(limitUp) && type === 'BUY' && price >= limitUp * 0.999) {
    return tradeError('已涨停，买单无法成交', 400);
  }
  if (Number.isFinite(limitDown) && type === 'SELL' && price <= limitDown * 1.001) {
    return tradeError('已跌停，卖单无法成交', 400);
  }
  return null;
}
