// 交易记录服务层：分页查询与字段映射，与 HTTP 解耦。

import pool from '../db.js';

export async function listTransactions(uid, page = 1, size = 20) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(50, Number(size) || 20);
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
