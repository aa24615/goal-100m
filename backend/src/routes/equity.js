import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { getDetail } from '../market.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';

/**
 * 资产曲线 / 账户分账
 * - gran=day（默认）：按「自然日」聚合 asset_snapshots，每天取当日最后一条快照作为该日收盘净值
 * - gran=minute：今日分时，按分钟取当日最后一条快照（快照每分钟写入一次）
 * - 缺失日期/分钟用前一已知值前值填充（ffill），保证曲线连续
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
// 当前上海时间 HH:mm（不依赖进程 TZ，容器若跑在 UTC 下标签也不会错 8 小时）
const nowHmStr = () => new Date(Date.now() + 8 * HOUR).toISOString().slice(11, 16);

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

// 把某一时刻的资产状态转成曲线上的一个点
function point(date, a, initialCapital) {
  const profit = a.totalAssets - initialCapital;
  return {
    date,
    cash: r2(a.cash),
    marketValue: r2(a.marketValue),
    totalAssets: r2(a.totalAssets),
    profit: r2(profit),
    returnPct: pct2((profit / initialCapital) * 100),
  };
}

// 最大回撤：相对历史最高净值的最大跌幅
function summarize(series, accounts, initialCapital) {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of series) {
    if (p.totalAssets > peak) peak = p.totalAssets;
    if (peak > 0) {
      const dd = ((peak - p.totalAssets) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }
  return {
    initialCapital,
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
  };
}

router.get(
  '/equity',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    // 契约只认 day/minute，未知值一律按日线，避免前端 gran 字段出现第三种取值
    const rawGran = String(req.query.gran || 'day').toLowerCase();
    const gran = rawGran === 'minute' ? 'minute' : 'day';
    const raw = Number(req.query.days);
    const days = [7, 30, 90, 365, 0].includes(raw) ? raw : 30; // 0 = 全部

    const u = await pool.query('SELECT created_at FROM users WHERE id=$1', [uid]);
    if (!u.rows[0]) {
      logger.warn('查询资产曲线失败: 用户不存在', { userId: uid });
      return res.status(404).json({ error: '用户不存在' });
    }

    const accounts = await currentAccounts(uid);
    if (!accounts) return res.status(404).json({ error: '用户不存在' });
    const { initialCapital } = accounts;

    const todayIdx = shDayIndex(Date.now());

    // ---------- 今日分时 ----------
    if (gran === 'minute') {
      const since = new Date(startOfShDay(todayIdx));

      // 今日之前最近的一条快照，作为曲线起点前值；没有则用开户初始资金
      const prev = await pool.query(
        `SELECT cash, market_value, total_assets FROM asset_snapshots
         WHERE user_id=$1 AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
        [uid, since]
      );

      const q = await pool.query(
        `SELECT DISTINCT ON (b) b,
                to_char(b, 'YYYY-MM-DD HH24:MI') AS label,
                cash, market_value, total_assets
         FROM (
           SELECT date_trunc('minute', created_at AT TIME ZONE $2) AS b,
                  cash, market_value, total_assets, created_at
           FROM asset_snapshots
           WHERE user_id = $1 AND created_at >= $3
         ) t
         ORDER BY b, created_at DESC`,
        [uid, TZ, since]
      );

      const series = [];
      for (const r of q.rows) {
        series.push(
          point(
            r.label,
            {
              cash: Number(r.cash),
              marketValue: Number(r.market_value),
              totalAssets: Number(r.total_assets),
            },
            initialCapital
          )
        );
      }
      // 末点用实时资产覆盖，保证「当下」准确；若当前分钟已有快照则覆盖该点，避免出现重复横坐标
      const liveLabel = `${dateStr(todayIdx)} ${nowHmStr()}`;
      const livePoint = point(liveLabel, accounts, initialCapital);
      if (series.length > 0 && series[series.length - 1].date === liveLabel) {
        series[series.length - 1] = livePoint;
      } else {
        series.push(livePoint);
      }

      return res.json({
        ...summarize(series, accounts, initialCapital),
        gran: 'minute',
        days: 1,
        range: { from: series[0]?.date ?? '-', to: series[series.length - 1]?.date ?? '-' },
      });
    }

    // ---------- 日线 ----------
    const createdIdx = shDayIndex(new Date(u.rows[0].created_at).getTime());
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
      series.push(point(ds, last, initialCapital));
    }

    // 末点用实时资产覆盖，保证「当下」准确
    if (series.length > 0) {
      series[series.length - 1] = point(dateStr(todayIdx), accounts, initialCapital);
    }

    res.json({
      ...summarize(series, accounts, initialCapital),
      gran: 'day',
      days,
      range: { from: dateStr(fromIdx), to: dateStr(todayIdx) },
    });
  })
);

export default router;
