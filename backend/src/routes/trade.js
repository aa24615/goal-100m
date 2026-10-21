import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { getDetail, addTradeVolume } from '../market.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';
import { calcFees, T1_ENABLED, PRICE_TOLERANCE, DAILY_LIMIT } from '../fees.js';

const router = express.Router();

function shToday(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// pg 会把 DATE 解析为 Date 对象，统一转成 'YYYY-MM-DD' 再比较
function dateStrOf(v) {
  if (!v) return '';
  if (v instanceof Date) return new Date(v.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// 可卖数量：T+1 下当日买入部分冻结
export function availableQty(row) {
  const qty = row.quantity;
  if (!T1_ENABLED) return qty;
  const frozen = dateStrOf(row.last_buy_date) === shToday() ? row.t1_qty || 0 : 0;
  return Math.max(0, qty - frozen);
}

function tradeError(message, status, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra || {};
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
        await client.query('ROLLBACK').catch(() => {});
        logger.warn('买入失败: 可用资金不足', {
          userId: uid,
          code,
          quantity,
          need: Math.round(total * 100) / 100,
          cash,
        });
        throw tradeError('可用资金不足', 400);
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
        throw tradeError('可用持仓不足', 400);
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
          400
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
  if (type === 'BUY' && price >= limitUp * 0.999) {
    return tradeError('已涨停，买单无法成交', 400);
  }
  if (type === 'SELL' && price <= limitDown * 1.001) {
    return tradeError('已跌停，卖单无法成交', 400);
  }
  return null;
}

// 持仓与资产概览
router.get(
  '/portfolio',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const u = await pool.query('SELECT cash, initial_capital FROM users WHERE id=$1', [uid]);
    if (!u.rows[0]) {
      logger.warn('查询持仓失败: 用户不存在', { userId: uid });
      return res.status(404).json({ error: '用户不存在' });
    }
    const cash = Number(u.rows[0].cash);
    const initial = Number(u.rows[0].initial_capital);
    const h = await pool.query('SELECT * FROM holdings WHERE user_id=$1', [uid]);

    const holdings = [];
    let marketValue = 0;
    let costValue = 0;
    for (const r of h.rows) {
      const d = getDetail(r.stock_code);
      const price = d ? d.price : Number(r.avg_cost);
      const qty = r.quantity;
      const mv = qty * price;
      const cv = qty * Number(r.avg_cost);
      marketValue += mv;
      costValue += cv;
      holdings.push({
        code: r.stock_code,
        name: d ? d.name : r.stock_code,
        quantity: qty,
        availableQty: availableQty(r),
        avgCost: Number(r.avg_cost),
        price,
        marketValue: Math.round(mv * 100) / 100,
        pnl: Math.round((mv - cv) * 100) / 100,
        pnlPct: cv ? Math.round(((mv - cv) / cv) * 10000) / 100 : 0,
      });
    }
    const totalAssets = cash + marketValue;
    res.json({
      cash,
      initialCapital: initial,
      marketValue: Math.round(marketValue * 100) / 100,
      costValue: Math.round(costValue * 100) / 100,
      totalAssets: Math.round(totalAssets * 100) / 100,
      totalPnl: Math.round((totalAssets - initial) * 100) / 100,
      totalPnlPct: Math.round(((totalAssets - initial) / initial) * 10000) / 100,
      t1Enabled: T1_ENABLED,
      holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
    });
  })
);

// 市价买卖交易
router.post(
  '/trade',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const { code, type, quantity } = req.body || {};
    const clientPrice = Number(req.body?.clientPrice);
    if (!code || !['BUY', 'SELL'].includes(type) || !Number.isInteger(quantity) || quantity <= 0) {
      logger.warn('交易失败: 参数错误', { userId: uid, code, type, quantity });
      return res.status(400).json({ error: '参数错误' });
    }
    const c = code.toUpperCase();
    const d = getDetail(c);
    if (!d) {
      logger.warn('交易失败: 股票不存在', { userId: uid, code: c });
      return res.status(404).json({ error: '股票不存在' });
    }

    const price = d.price;
    const err = validateOrder({
      type,
      price,
      limitUp: d.prevClose * (1 + DAILY_LIMIT),
      limitDown: d.prevClose * (1 - DAILY_LIMIT),
      clientPrice,
    });
    if (err) {
      logger.warn('下单校验未通过', { userId: uid, code: c, type, reason: err.message });
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }

    const result = await executeTrade({ uid, code: c, type, quantity, price, stockName: d.name });
    res.json(result);
  })
);

// 交易记录
router.get(
  '/transactions',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(50, Number(req.query.size) || 20);
    const off = (page - 1) * size;
    const c = await pool.query('SELECT COUNT(*)::int AS t FROM transactions WHERE user_id=$1', [uid]);
    const r = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [uid, size, off]
    );
    res.json({
      total: c.rows[0].t,
      page,
      size,
      items: r.rows.map((x) => ({
        id: x.id,
        stockCode: x.stock_code,
        stockName: x.stock_name,
        type: x.type,
        quantity: x.quantity,
        price: Number(x.price),
        amount: Number(x.amount),
        fee: Number(x.fee),
        realizedPnl: x.realized_pnl === null ? null : Number(x.realized_pnl),
        createdAt: x.created_at,
      })),
    });
  })
);

export default router;
