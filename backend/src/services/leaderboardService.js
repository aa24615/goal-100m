// 排行榜服务层：周期起点计算、净值与超额收益聚合、结果缓存。
// 把原本混在路由里的复杂 SQL 聚合与缓存逻辑下沉，路由只负责取数与返回。

import pool from '../db.js';
import { getDetail, getSummary } from '../market.js';
import { logger } from '../logger.js';

export const PERIODS = ['week', 'month', 'quarter', 'year', 'all'];
const CACHE_TTL_MS = Number(process.env.LEADERBOARD_CACHE_MS || 20000); // 结果缓存 20 秒
const TOP_N = 50;

const cache = new Map(); // period -> { at, data, benchmarkPct }

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

export async function buildLeaderboard(period) {
  const start = periodStart(period);

  // 一次取出所有用户与其持仓（避免 N+1 查询）
  const u = await pool.query('SELECT id, username, cash, initial_capital FROM users ORDER BY id');
  if (u.rows.length === 0) return { benchmarkPct: 0, rows: [] };

  const h = await pool.query('SELECT user_id, stock_code, quantity, avg_cost FROM holdings');
  const tx = await pool.query(
    'SELECT user_id, COUNT(*)::int AS c FROM transactions GROUP BY user_id'
  );
  const tradeMap = new Map(tx.rows.map((r) => [r.user_id, r.c]));
  // RQ-34：重置次数与起点变化标注 —— 反复重开的账号不再与「从未重置」的账号混排比较
  const rst = await pool.query(
    'SELECT user_id, COUNT(*)::int AS c, MAX(created_at) AS at FROM account_resets GROUP BY user_id'
  );
  const resetMap = new Map(rst.rows.map((r) => [r.user_id, { count: r.c, at: r.at }]));

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
      resetCount: resetMap.get(x.id)?.count || 0,
      lastResetAt: resetMap.get(x.id)?.at || null,
    });
  }
  // 注意：排名必须基于全量用户计算后再切片，否则切片外用户的 rank 会失真
  result.sort((a, b) => b.returnPct - a.returnPct);
  result.forEach((r, i) => {
    r.rank = i + 1;
  });

  logger.debug('排行榜计算完成', { period, users: result.length, benchmarkPct });
  return { benchmarkPct, rows: result };
}

/**
 * 取展示用榜单：前 TOP_N 名 + 钉住的「我的排名」。
 *
 * 只返回前 N 名会让榜外用户永远看不到自己 —— 既无法感知名次，
 * 也看不到 RQ-34 标注的重置次数。因此对登录用户追加一行自己的真实排名，
 * 用 isSelf 标记供前端高亮/吸底展示。
 *
 * @param {Array} rows 全量已排名数据
 * @param {number|null} selfId 当前登录用户 id（游客为 null）
 */
export function pickBoard(rows = [], selfId = null, limit = TOP_N) {
  const top = rows.slice(0, limit);
  if (selfId == null) return top;
  if (top.some((r) => r.id === selfId)) return top;
  const me = rows.find((r) => r.id === selfId);
  return me ? [...top, { ...me, isSelf: true }] : top;
}

/** 带缓存的排行榜取数：路由层与 benchmark 接口共用同一份缓存 */
export async function getCachedLeaderboard(period) {
  const hit = cache.get(period);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { data: hit.data, benchmarkPct: hit.benchmarkPct };
  }
  const { benchmarkPct, rows } = await buildLeaderboard(period);
  cache.set(period, { at: Date.now(), data: rows, benchmarkPct });
  return { data: rows, benchmarkPct };
}
