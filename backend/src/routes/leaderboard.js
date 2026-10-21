import express from 'express';
import pool from '../db.js';
import { getDetail, getSummary } from '../market.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';

const router = express.Router();

const PERIODS = ['week', 'month', 'quarter', 'year', 'all'];
const CACHE_TTL_MS = Number(process.env.LEADERBOARD_CACHE_MS || 20000); // 结果缓存 20 秒
const TOP_N = 50;

const cache = new Map(); // period -> { at, data }

/**
 * 周期起点（自然周/月/季/年，按服务器时区）
 * - week：本周一 00:00；month：本月 1 号；quarter：本季首月 1 号；year：本年 1 月 1 日
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

async function buildLeaderboard(period) {
  const start = periodStart(period);

  // 一次取出所有用户与其持仓（避免 N+1 查询）
  const u = await pool.query('SELECT id, username, cash, initial_capital FROM users ORDER BY id');
  if (u.rows.length === 0) return { benchmarkPct: 0, rows: [] };

  const h = await pool.query('SELECT user_id, stock_code, quantity, avg_cost FROM holdings');
  const tx = await pool.query(
    "SELECT user_id, COUNT(*)::int AS c FROM transactions GROUP BY user_id"
  );
  const tradeMap = new Map(tx.rows.map((r) => [r.user_id, r.c]));

  const holdMap = new Map();
  for (const r of h.rows) {
    const arr = holdMap.get(r.user_id) || [];
    arr.push(r);
    holdMap.set(r.user_id, arr);
  }

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

  // 大盘基准：同期指数涨跌，用于计算超额收益（跑赢/跑输大盘）
  let benchmarkPct = 0;
  const summary = getSummary();
  if (start) {
    const b = await pool.query(
      'SELECT index_value FROM index_snapshots WHERE created_at <= $1 ORDER BY created_at DESC LIMIT 1',
      [start.toISOString()]
    );
    if (b.rows.length > 0) {
      const baseIdx = Number(b.rows[0].index_value);
      if (baseIdx > 0) {
        benchmarkPct = Math.round(((summary.indexValue - baseIdx) / baseIdx) * 10000) / 100;
      }
    }
  }
  if (benchmarkPct === 0) benchmarkPct = summary.indexPct;

  const result = [];
  for (const x of u.rows) {
    let mv = 0;
    for (const r of holdMap.get(x.id) || []) {
      const d = getDetail(r.stock_code);
      const price = d ? d.price : Number(r.avg_cost);
      mv += r.quantity * price;
    }
    const total = Number(x.cash) + mv;
    const base = start && baseMap.has(x.id) ? baseMap.get(x.id) : Number(x.initial_capital);
    const returnPct = base ? Math.round(((total - base) / base) * 10000) / 100 : 0;
    result.push({
      id: x.id,
      username: x.username,
      cash: Number(x.cash),
      marketValue: Math.round(mv * 100) / 100,
      totalAssets: Math.round(total * 100) / 100,
      baseAssets: Math.round(base * 100) / 100,
      returnPct,
      excessPct: Math.round((returnPct - benchmarkPct) * 100) / 100,
      tradeCount: tradeMap.get(x.id) || 0,
    });
  }
  result.sort((a, b) => b.returnPct - a.returnPct);
  result.forEach((r, i) => {
    r.rank = i + 1;
  });

  logger.debug('排行榜计算完成', { period, users: result.length, benchmarkPct });
  return { benchmarkPct, rows: result.slice(0, TOP_N) };
}

router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.period || 'all');
    const period = PERIODS.includes(raw) ? raw : 'all';

    const hit = cache.get(period);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json(hit.data);
    }

    const { benchmarkPct, rows } = await buildLeaderboard(period);
    const payload = rows;
    cache.set(period, { at: Date.now(), data: payload, benchmarkPct });
    // 大盘基准与统计口径一并返回，前端用于展示「超越大盘」
    res.set('X-Benchmark-Pct', String(benchmarkPct));
    res.json(payload);
  })
);

// 排行榜元信息：同期大盘涨幅（超额收益基准）
router.get(
  '/leaderboard/benchmark',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.period || 'all');
    const period = PERIODS.includes(raw) ? raw : 'all';
    const hit = cache.get(period);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json({ period, benchmarkPct: hit.benchmarkPct ?? 0 });
    }
    const { benchmarkPct, rows } = await buildLeaderboard(period);
    cache.set(period, { at: Date.now(), data: rows, benchmarkPct });
    res.json({ period, benchmarkPct });
  })
);

export default router;
