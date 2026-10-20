import express from 'express';
import pool from '../db.js';
import { getDetail } from '../market.js';
import { asyncHandler } from '../middleware.js';

const router = express.Router();

const PERIODS = ['week', 'month', 'quarter', 'year', 'all'];

/**
 * 周期起点（自然周/月/季/年，按服务器时区）
 * - week：本周一 00:00
 * - month：本月 1 号 00:00
 * - quarter：本季度首月 1 号 00:00
 * - year：本年 1 月 1 日 00:00
 * - all：null，表示用初始资金作基准
 */
function periodStart(period) {
  const d = new Date();
  switch (period) {
    case 'week': {
      const day = d.getDay(); // 0=周日
      const diff = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diff);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case 'month':
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return d;
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3);
      d.setMonth(q * 3, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case 'year':
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    default:
      return null;
  }
}

router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.period || 'all');
    const period = PERIODS.includes(raw) ? raw : 'all';
    const start = periodStart(period);

    const u = await pool.query('SELECT id, username, cash, initial_capital FROM users ORDER BY id');
    if (u.rows.length === 0) return res.json([]);

    // 周期基准：取「周期起点之前最近的一条快照」；无快照则退回初始资金
    const baseMap = new Map();
    if (start) {
      const s = await pool.query(
        `SELECT DISTINCT ON (user_id) user_id, total_assets
         FROM asset_snapshots
         WHERE created_at <= $1
         ORDER BY user_id, created_at DESC`,
        [start.toISOString()]
      );
      for (const r of s.rows) baseMap.set(r.user_id, Number(r.total_assets));
    }

    const result = [];
    for (const x of u.rows) {
      const h = await pool.query('SELECT * FROM holdings WHERE user_id=$1', [x.id]);
      let mv = 0;
      for (const r of h.rows) {
        const d = getDetail(r.stock_code);
        const price = d ? d.price : Number(r.avg_cost);
        mv += r.quantity * price;
      }
      const total = Number(x.cash) + mv;
      const base = start && baseMap.has(x.id) ? baseMap.get(x.id) : Number(x.initial_capital);
      result.push({
        id: x.id,
        username: x.username,
        cash: Number(x.cash),
        marketValue: Math.round(mv * 100) / 100,
        totalAssets: Math.round(total * 100) / 100,
        baseAssets: Math.round(base * 100) / 100,
        returnPct: base ? Math.round(((total - base) / base) * 10000) / 100 : 0,
      });
    }
    result.sort((a, b) => b.returnPct - a.returnPct);
    result.forEach((r, i) => {
      r.rank = i + 1;
    });
    res.json(result.slice(0, 50));
  })
);

export default router;
