import pool from './db.js';
import { getDetail } from './market.js';
import { logger } from './logger.js';
import { executeTrade } from './routes/trade.js';
import { calcFees, DAILY_LIMIT } from './fees.js';

/**
 * 限价委托（挂单 / 撤单 / 撮合）
 * - 委托保存于 orders 表，状态 PENDING / FILLED / CANCELLED
 * - 每个行情 tick 后尝试撮合：买单价格 >= 市价则成交，卖单价格 <= 市价则成交
 * - 成交复用 executeTrade，与市价单共用资金校验、T+1、费用与盈亏逻辑
 */

function shToday(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function listOrders(userId, status) {
  const args = [userId];
  let sql = 'SELECT * FROM orders WHERE user_id=$1';
  if (status) {
    sql += ' AND status=$2';
    args.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const { rows } = await pool.query(sql, args);
  return rows.map((o) => ({
    id: o.id,
    code: o.stock_code,
    name: o.stock_name,
    side: o.side,
    limitPrice: Number(o.limit_price),
    quantity: o.quantity,
    status: o.status,
    filledPrice: o.filled_price === null ? null : Number(o.filled_price),
    note: o.note,
    createdAt: o.created_at,
  }));
}

export async function createOrder({ userId, code, side, limitPrice, quantity }) {
  const c = String(code || '').toUpperCase();
  const d = getDetail(c);
  if (!d) return { error: '股票不存在', status: 404 };
  if (!['BUY', 'SELL'].includes(side)) return { error: '方向错误', status: 400 };
  const price = Number(limitPrice);
  if (!Number.isFinite(price) || price <= 0) return { error: '委托价无效', status: 400 };
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity % 100 !== 0) {
    return { error: '委托数量需为 100 的整数倍', status: 400 };
  }

  const hi = d.prevClose * (1 + DAILY_LIMIT);
  const lo = d.prevClose * (1 - DAILY_LIMIT);
  const limit = Math.round(Math.min(hi, Math.max(lo, price)) * 100) / 100;

  // 下单即预估资金/持仓是否足够，提前拦截明显不可能成交的委托
  const u = await pool.query('SELECT cash FROM users WHERE id=$1', [userId]);
  if (u.rows.length === 0) return { error: '用户不存在', status: 404 };
  if (side === 'BUY') {
    const need = limit * quantity + calcFees(limit * quantity, 'BUY');
    if (need > Number(u.rows[0].cash)) {
      return { error: `资金不足，预计需 ¥${need.toFixed(2)}`, status: 400 };
    }
  } else {
    const h = await pool.query('SELECT quantity, t1_qty, last_buy_date FROM holdings WHERE user_id=$1 AND stock_code=$2', [
      userId,
      c,
    ]);
    const row = h.rows[0];
    const lastBuy =
      row?.last_buy_date instanceof Date
        ? new Date(row.last_buy_date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
        : String(row?.last_buy_date || '').slice(0, 10);
    const frozen = lastBuy === shToday() ? row.t1_qty || 0 : 0;
    const sellable = row ? Math.max(0, row.quantity - frozen) : 0;
    if (sellable < quantity) {
      return { error: `可卖数量不足，当前可卖 ${sellable} 股`, status: 400 };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO orders (user_id, stock_code, stock_name, side, limit_price, quantity)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, c, d.name, side, limit, quantity]
  );
  logger.info('限价委托已提交', { userId, code: c, side, limitPrice: limit, quantity });
  return { id: rows[0].id, code: c, status: 'PENDING' };
}

export async function cancelOrder({ userId, orderId }) {
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE id=$1 AND user_id=$2 AND status='PENDING'",
    [orderId, userId]
  );
  if (rows.length === 0) return { error: '委托不存在或已结束', status: 404 };
  await pool.query(
    "UPDATE orders SET status='CANCELLED', updated_at=now() WHERE id=$1",
    [orderId]
  );
  logger.info('限价委托已撤销', { userId, orderId, code: rows[0].stock_code });
  return { ok: true, id: orderId };
}

/**
 * 撮合：对每个 tick 检查所有未成交委托
 * 买单：委托价 >= 当前市价 → 成交；卖单：委托价 <= 当前市价 → 成交
 */
export async function matchOrders() {
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE status='PENDING' ORDER BY created_at ASC LIMIT 200"
  );
  if (rows.length === 0) return 0;

  let filled = 0;
  for (const o of rows) {
    const d = getDetail(o.stock_code);
    if (!d) continue;
    const market = d.price;
    const canFill =
      (o.side === 'BUY' && Number(o.limit_price) >= market) ||
      (o.side === 'SELL' && Number(o.limit_price) <= market);
    if (!canFill) continue;

    // 涨停买 / 跌停卖 依然不可成交
    const hi = d.prevClose * (1 + DAILY_LIMIT);
    const lo = d.prevClose * (1 - DAILY_LIMIT);
    if (o.side === 'BUY' && market >= hi * 0.999) continue;
    if (o.side === 'SELL' && market <= lo * 1.001) continue;

    try {
      await executeTrade({
        uid: o.user_id,
        code: o.stock_code,
        type: o.side,
        quantity: o.quantity,
        price: market,
        stockName: o.stock_name,
      });
      await pool.query(
        "UPDATE orders SET status='FILLED', filled_price=$1, updated_at=now() WHERE id=$2",
        [market, o.id]
      );
      filled += 1;
      logger.info('限价委托成交', {
        orderId: o.id,
        userId: o.user_id,
        code: o.stock_code,
        side: o.side,
        price: market,
      });
    } catch (e) {
      // 资金/持仓不足等业务原因：保留委托继续等待，仅记录
      if (e && e.status) {
        await pool.query('UPDATE orders SET note=$1, updated_at=now() WHERE id=$2', [
          e.message,
          o.id,
        ]);
        logger.warn('限价委托暂不可成交', { orderId: o.id, reason: e.message });
      } else {
        logger.error('限价委托撮合异常', { orderId: o.id, err: e });
      }
    }
  }
  return filled;
}
