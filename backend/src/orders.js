import pool from './db.js';
import { getDetail } from './market.js';
import { logger } from './logger.js';
import { executeTrade } from './services/tradeService.js';
import { calcFees } from './fees.js';
import { guardTrade, priceLimitOf } from './rules.js';

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

  // RQ-49/50：与市价单共用 rules.guardTrade 口径（分板块涨跌幅 + 停牌 + 整手）
  const guard = guardTrade({
    code: c,
    name: d.name,
    type: side,
    price,
    prevClose: d.prevClose,
    volume: d.volume,
    quantity,
    tradeStatus: d.halted ? 'HALTED' : d.tradeStatus,
    listingDate: d.listingDate,
  });
  if (!guard.ok) return { error: guard.message, status: guard.status, rule: guard.code };

  const { limitUp, limitDown } = guard.limits;
  // 有涨跌幅约束时把越界委托价夹回区间（前端可能按旧价提交）；免涨跌幅时原样保留
  const limit =
    limitUp != null && limitDown != null
      ? Math.round(Math.min(limitUp, Math.max(limitDown, price)) * 100) / 100
      : Math.round(price * 100) / 100;

  // 下单即预估资金/持仓是否足够，提前拦截明显不可能成交的委托
  const u = await pool.query('SELECT cash FROM users WHERE id=$1', [userId]);
  if (u.rows.length === 0) return { error: '用户不存在', status: 404 };
  const cashNow = Number(u.rows[0].cash);
  if (side === 'BUY') {
    const needRaw = limit * quantity + calcFees(limit * quantity, 'BUY');
    if (needRaw > cashNow) {
      // 与市价单（tradeService）口径一致：带 need/cash/shortfall，避免用户盲试数量
      const need = Math.round(needRaw * 100) / 100;
      return {
        error: `资金不足，预计需 ¥${need.toFixed(2)}`,
        status: 400,
        need,
        cash: cashNow,
        shortfall: Math.round((need - cashNow) * 100) / 100,
      };
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
      return {
        error: `可卖数量不足，当前可卖 ${sellable} 股`,
        status: 400,
        want: quantity,
        sellable,
      };
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

// 撮合重入保护：撮合是「选出 PENDING → 逐条 executeTrade」的非原子过程，
// 而调用方（market.js 的 tick 钩子）不 await 本函数，tick 间隔默认 2s。
// 一旦单轮耗时超过间隔，下一 tick 会并发拉起第二个 matchOrders，
// 两者读到同一批 PENDING 委托 —— 若无防重入，同一条委托会被成交两次。
let matching = false;

/**
 * 撮合：对每个 tick 检查所有未成交委托
 * 买单：委托价 >= 当前市价 → 成交；卖单：委托价 <= 当前市价 → 成交
 */
export async function matchOrders() {
  if (matching) return 0;
  matching = true;
  try {
    return await doMatchOrders();
  } finally {
    matching = false;
  }
}

async function doMatchOrders() {
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

    // 涨停买 / 跌停卖 依然不可成交（按分板块幅度，RQ-49）
    const lim = priceLimitOf(o.stock_code, d.name, d.prevClose, d.listingDate);
    const halted = d.halted;
    if (halted) continue; // 停牌/退市标的即使价格触发也不撮合（RQ-50）
    if (Number.isFinite(lim.limitUp) && o.side === 'BUY' && market >= lim.limitUp * 0.999) continue;
    if (Number.isFinite(lim.limitDown) && o.side === 'SELL' && market <= lim.limitDown * 1.001) continue;

    // 原子占位：先把委托抢成 FILLED，只有抢占成功（此前确实还是 PENDING）才真正成交。
    // 修复前这里是 executeTrade 成功扣款后才无条件 UPDATE 置位，有两个后果：
    //   ① 撤单被「复活」：用户在撮合窗口内撤单后，status 被覆盖回 FILLED，
    //      而资金/持仓已经变动且无法回滚；
    //   ② 重复成交：两轮撮合（重入或重启后）读到同一条委托，两轮都会 executeTrade 成功。
    // 用带 status 条件的 UPDATE 让数据库行锁做裁决：只有 rowCount=1 的一方继续成交。
    const claim = await pool.query(
      "UPDATE orders SET status='FILLED', filled_price=$1, updated_at=now() WHERE id=$2 AND status='PENDING'",
      [market, o.id]
    );
    if (claim.rowCount === 0) continue; // 已被撤单或已被其它轮次成交

    try {
      await executeTrade({
        uid: o.user_id,
        code: o.stock_code,
        type: o.side,
        quantity: o.quantity,
        price: market,
        stockName: o.stock_name,
      });
      filled += 1;
      logger.info('限价委托成交', {
        orderId: o.id,
        userId: o.user_id,
        code: o.stock_code,
        side: o.side,
        price: market,
      });
    } catch (e) {
      // 占位已抢到但成交失败：回退为 PENDING，让委托继续等待下一次撮合。
      // 不回退会让委托卡在 FILLED 但资金/持仓并未变动，用户也永远等不到成交。
      const isBusiness = Boolean(e && e.status);
      const reason = isBusiness ? e.message : '撮合异常，已回退为待成交';
      await pool.query(
        "UPDATE orders SET status='PENDING', filled_price=NULL, note=$1, updated_at=now() WHERE id=$2",
        [reason, o.id]
      );
      if (isBusiness) {
        logger.warn('限价委托暂不可成交', { orderId: o.id, reason: e.message });
      } else {
        logger.error('限价委托撮合异常', { orderId: o.id, err: e });
      }
    }
  }
  return filled;
}
