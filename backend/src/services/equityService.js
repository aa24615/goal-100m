// 资产曲线 / 账户分账服务层：日线与今日分时聚合、最大回撤、实时末点覆盖。
// 与 HTTP 解耦，便于集成测试直接传入 uid/gran/days 验证曲线口径。

import pool from '../db.js';
import { getDetail } from '../market.js';
import { logger } from '../logger.js';
import {
  round2,
  pct2,
  shDayIndex,
  startOfShDay,
  dateStr,
  nowHmStr,
} from '../utils/time.js';

const TZ = 'Asia/Shanghai';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// 以「上海时区」为准的自然日序号与日期串，避免容器 UTC 导致跨日错位
const shDayIndexLocal = shDayIndex;
const startOfShDayLocal = startOfShDay;
const dateStrLocal = dateStr;
const nowHmStrLocal = nowHmStr;

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
  return {
    cash,
    marketValue: mv,
    totalAssets: cash + mv,
    initialCapital: Number(u.rows[0].initial_capital),
  };
}

// 把某一时刻的资产状态转成曲线上的一个点
function point(date, a, initialCapital) {
  const profit = a.totalAssets - initialCapital;
  return {
    date,
    cash: round2(a.cash),
    marketValue: round2(a.marketValue),
    totalAssets: round2(a.totalAssets),
    profit: round2(profit),
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
      cash: round2(accounts.cash),
      marketValue: round2(accounts.marketValue),
      totalAssets: round2(accounts.totalAssets),
    },
    summary: {
      profit: round2(accounts.totalAssets - initialCapital),
      returnPct: pct2(((accounts.totalAssets - initialCapital) / initialCapital) * 100),
      maxDrawdown: pct2(maxDrawdown),
      peak: round2(peak === -Infinity ? accounts.totalAssets : peak),
    },
    series,
  };
}

export async function getEquity(uid, gran = 'day', days = 30) {
  const u = await pool.query('SELECT created_at FROM users WHERE id=$1', [uid]);
  if (!u.rows[0]) {
    const e = new Error('用户不存在');
    e.status = 404;
    e.expose = true;
    throw e;
  }

  const accounts = await currentAccounts(uid);
  if (!accounts) {
    const e = new Error('用户不存在');
    e.status = 404;
    throw e;
  }
  const { initialCapital } = accounts;

  const todayIdx = shDayIndexLocal(Date.now());

  // ---------- 今日分时 ----------
  if (gran === 'minute') {
    const since = new Date(startOfShDayLocal(todayIdx));

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
    const liveLabel = `${dateStrLocal(todayIdx)} ${nowHmStrLocal()}`;
    const livePoint = point(liveLabel, accounts, initialCapital);
    if (series.length > 0 && series[series.length - 1].date === liveLabel) {
      series[series.length - 1] = livePoint;
    } else {
      series.push(livePoint);
    }

    return {
      ...summarize(series, accounts, initialCapital),
      gran: 'minute',
      days: 1,
      range: { from: series[0]?.date ?? '-', to: series[series.length - 1]?.date ?? '-' },
    };
  }

  // ---------- 日线 ----------
  const createdIdx = shDayIndexLocal(new Date(u.rows[0].created_at).getTime());
  const fromIdx = days > 0 ? Math.max(createdIdx, todayIdx - (days - 1)) : createdIdx;

  // 多取 30 天，用于拿到区间起点之前最近的一条快照做前值填充
  const since = new Date(startOfShDayLocal(fromIdx) - 30 * DAY);
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
    if (ds <= dateStrLocal(fromIdx)) last = byDay.get(ds);
    else break;
  }

  const series = [];
  for (let i = fromIdx; i <= todayIdx; i += 1) {
    const ds = dateStrLocal(i);
    if (byDay.has(ds)) last = byDay.get(ds);
    series.push(point(ds, last, initialCapital));
  }

  // 末点用实时资产覆盖，保证「当下」准确
  if (series.length > 0) {
    series[series.length - 1] = point(dateStrLocal(todayIdx), accounts, initialCapital);
  }

  logger.debug('资产曲线计算完成', { uid, gran, days, points: series.length });
  return {
    ...summarize(series, accounts, initialCapital),
    gran: 'day',
    days,
    range: { from: dateStrLocal(fromIdx), to: dateStrLocal(todayIdx) },
  };
}
