// 交易记录服务层：分页查询与字段映射，与 HTTP 解耦。

import pool from '../db.js';
import { clampInt } from '../utils/num.js';

/** 分页场景单页上限（导出场景按「全量」语义由调用方放宽） */
export const DEFAULT_MAX_SIZE = 50;
/** 默认单页条数 */
const DEFAULT_SIZE = 20;
/** 页码上限：防御超大 page 造成的巨额 OFFSET */
const MAX_PAGE = 1000000;

/**
 * 分页查询交易记录。
 * @param {number} [maxSize] 单页上限。导出（/transactions/export）传更大的值，
 *   否则导出会被静默截断到 50 条，与路由里 size 最大 10000 的意图不符。
 */
export async function listTransactions(uid, page = 1, size = 20, maxSize = DEFAULT_MAX_SIZE) {
  const p = clampInt(page, 1, MAX_PAGE, 1);
  const s = clampInt(size, 1, maxSize, Math.min(DEFAULT_SIZE, maxSize));
  const off = (p - 1) * s;
  const c = await pool.query('SELECT COUNT(*)::int AS t FROM transactions WHERE user_id=$1', [uid]);
  const r = await pool.query(
    'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [uid, s, off]
  );
  return {
    total: c.rows[0].t,
    page: p,
    size: s,
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
  };
}
