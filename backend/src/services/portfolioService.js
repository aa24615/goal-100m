// 持仓与资产概览服务层：聚合现金、持仓市值、成本与浮动盈亏。

import pool from '../db.js';
import { getDetail } from '../market.js';
import { T1_ENABLED } from '../fees.js';
import { availableQty } from './tradeService.js';
import { round2, pct2 } from '../utils/time.js';

export async function getPortfolio(uid) {
  const u = await pool.query('SELECT cash, initial_capital FROM users WHERE id=$1', [uid]);
  if (!u.rows[0]) {
    const e = new Error('用户不存在');
    e.status = 404;
    e.expose = true;
    // 业务规则拒绝，非报文非法
    e.business = true;
    throw e;
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
      marketValue: round2(mv),
      pnl: round2(mv - cv),
      pnlPct: cv ? pct2(((mv - cv) / cv) * 10000) / 100 : 0,
    });
  }
  const totalAssets = cash + marketValue;
  return {
    cash,
    initialCapital: initial,
    marketValue: round2(marketValue),
    costValue: round2(costValue),
    totalAssets: round2(totalAssets),
    totalPnl: round2(totalAssets - initial),
    totalPnlPct: pct2(((totalAssets - initial) / initial) * 10000) / 100,
    t1Enabled: T1_ENABLED,
    holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
  };
}
