import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { getDetail } from '../market.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';

/**
 * 资产曲线 / 账户分账
 * - 按「自然日」聚合 asset_snapshots，每天取当日最后一条快照作为该日收盘净值
 * - 缺失日期用前一交易日的值前值填充（ffill），保证曲线连续
 * - 序列最后一点用实时资产覆盖（持仓按当前行情价计算），保证"当下"准确
 * - 账户分账：资金账户 = 可用现金；交易账户 = 持仓市值
 */

const router = express.Router();
const TZ = 'Asia/Shanghai';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const r2 = (n) => Math.round(n * 100) / 100;
const pct2 = (n) => Math.round(n * 100) / 100;

// 以「上海时区」为准的自然日序号与日期串，避免容器 UTC 导致跨日错位
const shDayIndex = (ms) => Math.floor((ms + 8 * HOUR) / DAY);
const startOfShDay = (idx) => idx * DAY - 8 * HOUR;
const dateStr = (idx) => new Date(startOfShDay(idx) + 8 * HOUR).toISOString().slice(0, 10);

async function currentAccounts(uid) {
  const u = await pool.query('SELECT cash, initial_capital FROM users WHERE id=$1', [uid]);
  if (!u.rows[0]) return null;
  const cash = Number(u.rows[0].cash);
  const h = await pool.query('SELECT * FROM holdings WHERE user_id=$1', [uid]);
  let mv = 0;
  for (const r of h.rows) {
    const d = getDetail(r.stock_code);
    mv += r.quantity * (d ? d.price : Number(r.avg_cost));
  }
  return { cash, marketValue: mv, totalAssets: cash + mv, initialCapital: Number(u.rows[0].initial_capital) };
}

router.get(
  '/equity',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const raw = Number(req.query.days);
    const days = [7, 30, 90, 365, 0].includes(raw) ? raw : 30; // 0 = 全部

    const u = await pool.query('SELECT created_at FROM users WHERE id=$1', [uid]);
    if (!u.rows[0]) {
      logger.warn('查询资产曲线失败: 用户不存在', { userId: uid });
      return res.status(404).json({ error: '用户不存在' });
    }

    const createdIdx = shDayIndex(new Date(u.rows[0].created_at).getTime());
    const todayIdx = shDayIndex(Date.now());
    const fromIdx = days > 0 ? Math.max(createdIdx, todayIdx - (days - 1)) : createdIdx;

    // 多取 30 天，用于拿到区间起点之前最近的一条快照做前值填充
    const since = new Date(startOfShDay(fromIdx) - 30 * DAY);
    const q = await pool.query(
      `SELECT DISTINCT ON (d) d,
              to_char(d, 'YYYY-MM-DD') AS ds,
              total_assets, cash, market_value
       FROM (
         SELECT ((created_at AT TIME ZONE $2)::date) AS d,
                total_assets, cash, market_value, created_at
         FROM asset_snapshots
         WHERE user_id = $1 AND created_at >= $3
       ) t
       ORDER BY d, created_at DESC`,
      [uid, TZ, since]
    );

    const byDay = new Map();
    const allDays = [];
    for (const r of q.rows) {
      byDay.set(r.ds, {
        cash: Number(r.cash),
        marketValue: Number(r.market_value),
        totalAssets: Number(r.total_assets),
      });
      allDays.push(r.ds);
    }
    allDays.sort();

    const accounts = await currentAccounts(uid);
    if (!accounts) return res.status(404).json({ error: '用户不存在' });
    const { initialCapital } = accounts;

    // 分钟级（今日分时）：日级点数不足时的兜底粒度，让开户当天也能看到曲线
    if (req.query.gran === 'minute') {
      const sinceMs = startOfShDay(todayIdx);
      const m = await pool.query(
        `SELECT to_char(created_at AT TIME ZONE $2, 'MM-DD HH24:MI') AS ts,
                total_assets, cash, market_value
         FROM asset_snapshots
         WHERE user_id = $1 AND created_at >= $3
         ORDER BY created_at ASC`,
        [uid, TZ, new Date(sinceMs)]
      );
      const step = Math.max(1, Math.ceil(m.rows.length / 300)); // 抽样，最多约 300 点
      const picked = m.rows.filter((_, i) => i % step === 0 || i === m.rows.length - 1);
      const minuteSeries = picked.map((r) => {
        const total = Number(r.total_assets);
        const profit = total - initialCapital;
        return {
          date: r.ts,
          cash: r2(Number(r.cash)),
          marketValue: r2(Number(r.market_value)),
          totalAssets: r2(total),
          profit: r2(profit),
          returnPct: pct2((profit / initialCapital) * 100),
        };
      });
      if (minuteSeries.length > 0) {
        const profit = accounts.totalAssets - initialCapital;
        minuteSeries[minuteSeries.length - 1] = {
          date: '现在',
          cash: r2(accounts.cash),
          marketValue: r2(accounts.marketValue),
          totalAssets: r2(accounts.totalAssets),
          profit: r2(profit),
          returnPct: pct2((profit / initialCapital) * 100),
        };
      }
      let mPeak = -Infinity;
      let mDd = 0;
      for (const p of minuteSeries) {
        if (p.totalAssets > mPeak) mPeak = p.totalAssets;
        if (mPeak > 0) mDd = Math.max(mDd, ((mPeak - p.totalAssets) / mPeak) * 100);
      }
      return res.json({
        initialCapital,
        days: 1,
        gran: 'minute',
        range: { from: dateStr(todayIdx), to: '现在' },
        accounts: {
          cash: r2(accounts.cash),
          marketValue: r2(accounts.marketValue),
          totalAssets: r2(accounts.totalAssets),
        },
        summary: {
          profit: r2(accounts.totalAssets - initialCapital),
          returnPct: pct2(((accounts.totalAssets - initialCapital) / initialCapital) * 100),
          maxDrawdown: pct2(mDd),
          peak: r2(mPeak === -Infinity ? accounts.totalAssets : mPeak),
        },
        series: minuteSeries,
      });
    }

    // 起始前值：区间起点之前最近的一条快照，没有则用「开户初始资金（全额现金）」
    let last = { cash: initialCapital, marketValue: 0, totalAssets: initialCapital };
    for (const ds of allDays) {
      if (ds <= dateStr(fromIdx)) last = byDay.get(ds);
      else break;
    }

    const series = [];
    for (let i = fromIdx; i <= todayIdx; i += 1) {
      const ds = dateStr(i);
      if (byDay.has(ds)) last = byDay.get(ds);
      const profit = last.totalAssets - initialCapital;
      series.push({
        date: ds,
        cash: r2(last.cash),
        marketValue: r2(last.marketValue),
        totalAssets: r2(last.totalAssets),
        profit: r2(profit),
        returnPct: pct2((profit / initialCapital) * 100),
      });
    }

    // 末点用实时资产覆盖，保证「当下」准确
    if (series.length > 0) {
      const profit = accounts.totalAssets - initialCapital;
      series[series.length - 1] = {
        date: dateStr(todayIdx),
        cash: r2(accounts.cash),
        marketValue: r2(accounts.marketValue),
        totalAssets: r2(accounts.totalAssets),
        profit: r2(profit),
        returnPct: pct2((profit / initialCapital) * 100),
      };
    }

    // 最大回撤：相对历史最高净值的最大跌幅
    let peak = -Infinity;
    let maxDrawdown = 0;
    for (const p of series) {
      if (p.totalAssets > peak) peak = p.totalAssets;
      if (peak > 0) {
        const dd = ((peak - p.totalAssets) / peak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    res.json({
      initialCapital,
      days,
      gran: 'day',
      range: { from: dateStr(fromIdx), to: dateStr(todayIdx) },
      accounts: {
        cash: r2(accounts.cash),
        marketValue: r2(accounts.marketValue),
        totalAssets: r2(accounts.totalAssets),
      },
      summary: {
        profit: r2(accounts.totalAssets - initialCapital),
        returnPct: pct2(((accounts.totalAssets - initialCapital) / initialCapital) * 100),
        maxDrawdown: pct2(maxDrawdown),
        peak: r2(peak === -Infinity ? accounts.totalAssets : peak),
      },
      series,
    });
  })
);

export default router;
