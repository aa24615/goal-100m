// 新手引导与成长体系服务（RQ-12 ~ RQ-15）
//
// - 四步引导：看懂行情 → 下一笔单 → 理解 T+1 与涨跌停 → 看懂盈亏（RQ-12）
// - 新手任务：完成态由真实行为（交易/自选/复盘/回放）推导，不是手填（RQ-14）
// - 连续练习与里程碑：纯荣誉性质，无任何实物或现金奖励（RQ-15）

import pool from '../db.js';
import { logger } from '../logger.js';
import { shToday } from '../utils/time.js';
import { track } from './analyticsService.js';

export const GUIDE_STEPS = [
  { step: 1, key: 'market', title: '看懂行情', desc: '列表里是全市场真实 A 股标的与真实行情，涨用红、跌用绿，点任意一只可以看分时走势。' },
  { step: 2, key: 'order', title: '下一笔单', desc: '进入个股页，在交易面板输入数量买入。买入数量需为 100 的整数倍（科创板 200 股起）。' },
  { step: 3, key: 'rules', title: '理解 T+1 与涨跌停', desc: '当日买入的股份次日才能卖出；价格相对昨收 ±10% 即涨跌停，涨停不能买、跌停不能卖。' },
  { step: 4, key: 'pnl', title: '看懂盈亏', desc: '持仓页显示浮动盈亏；卖出后进入「复盘战绩」可以看到这一笔赚了多少、持有了多久。' },
];

// 任务清单：unlocks 表示完成该任务后解锁的进阶功能（RQ-14）
export const TASK_DEFS = [
  { key: 'first_buy', label: '完成第一笔买入', hint: '在任意个股页面买入 100 股', unlocks: 'replay' },
  { key: 'first_sell', label: '完成第一笔卖出', hint: '卖出已持有的股份（注意 T+1）', unlocks: 'review' },
  { key: 'add_watch', label: '添加 1 只自选股', hint: '在行情列表点击星标', unlocks: 'watchlist_group' },
  { key: 'view_review', label: '查看一次复盘战绩', hint: '进入复盘战绩中心看看自己的胜率', unlocks: 'export' },
  { key: 'first_replay', label: '完成一次回放训练', hint: '在回放训练里重练一段历史行情', unlocks: 'scenario' },
];

export const MILESTONES = [
  { key: 'streak_3', label: '连续练习 3 天', check: (s) => s.streak?.best >= 3 },
  { key: 'streak_7', label: '连续练习 7 天', check: (s) => s.streak?.best >= 7 },
  { key: 'rounds_10', label: '完成 10 笔完整交易', check: (s) => (s.roundCount || 0) >= 10 },
  { key: 'replay_5', label: '完成 5 次回放训练', check: (s) => (s.replayCount || 0) >= 5 },
];

/* ------------------------- 纯函数：连续练习 ------------------------- */

/** 连续练习天数推进（同一天重复打卡不累加，断签则重置为 1） */
export function advanceStreak(streak, today) {
  const cur = Number(streak?.current || 0);
  const best = Number(streak?.best || 0);
  const last = streak?.lastDate || null;
  if (last === today) return { current: cur, best: Math.max(best, cur), lastDate: today, repeated: true };

  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  const next = last === yesterday ? cur + 1 : 1;
  return { current: next, best: Math.max(best, next), lastDate: today, repeated: false };
}

/* ------------------------- DB 层 ------------------------- */

async function ensureRow(userId) {
  await pool.query(
    `INSERT INTO onboarding_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const { rows } = await pool.query('SELECT * FROM onboarding_state WHERE user_id=$1', [userId]);
  return rows[0];
}

/** 由真实行为推导任务完成态（RQ-14：状态实时更新） */
async function evaluateTasks(userId, prevTasks = []) {
  const done = new Map(prevTasks.map((t) => [t.key, t]));
  const now = new Date().toISOString();

  const tx = await pool.query(
    'SELECT type, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at ASC',
    [userId]
  );
  const hasBuy = tx.rows.some((r) => r.type === 'BUY');
  const hasSell = tx.rows.some((r) => r.type === 'SELL');
  const w = await pool.query('SELECT COUNT(*)::int AS c FROM watchlist WHERE user_id=$1', [userId]);
  const rv = await pool.query(
    "SELECT COUNT(*)::int AS c FROM analytics_events WHERE user_id=$1 AND event='review_view'",
    [userId]
  );
  const rp = await pool.query(
    "SELECT COUNT(*)::int AS c FROM analytics_events WHERE user_id=$1 AND event='replay_finish'",
    [userId]
  );
  const countOf = (k) => ({ buy: hasBuy, sell: hasSell, watch: w.rows[0]?.c || 0, review: rv.rows[0]?.c || 0, replay: rp.rows[0]?.c || 0 }[k]);

  const truth = {
    first_buy: hasBuy,
    first_sell: hasSell,
    add_watch: countOf('watch') >= 1,
    view_review: countOf('review') >= 1,
    first_replay: countOf('replay') >= 1,
  };

  let changed = false;
  const tasks = TASK_DEFS.map((d) => {
    const ok = Boolean(truth[d.key]);
    const old = done.get(d.key);
    if (ok && !old?.done) changed = true;
    return {
      key: d.key,
      label: d.label,
      hint: d.hint,
      unlocks: d.unlocks,
      done: ok,
      doneAt: ok ? old?.doneAt || now : null,
    };
  });

  // 新完成的任务补一条埋点，保证「引导完成」类行为可度量（RQ-35）
  if (changed) {
    for (const t of tasks.filter((x) => x.done && !prevTasks.find((p) => p.key === x.key && p.done))) {
      await track(userId, 'task_complete', { key: t.key });
    }
  }
  return tasks;
}

export async function getState(userId) {
  await ensureRow(userId);
  const row = await ensureRow(userId);
  const tasks = await evaluateTasks(userId, row.tasks || []);
  if (JSON.stringify(tasks) !== JSON.stringify(row.tasks || [])) {
    await pool.query('UPDATE onboarding_state SET tasks=$1, updated_at=now() WHERE user_id=$2', [
      JSON.stringify(tasks),
      userId,
    ]);
  }
  const ms = await pool.query(
    'SELECT key, label, achieved_at FROM user_milestones WHERE user_id=$1 ORDER BY achieved_at ASC',
    [userId]
  );
  return {
    guideStep: row.guide_step,
    guideDone: row.guide_done,
    guideSkipped: row.guide_skipped,
    steps: GUIDE_STEPS,
    tasks,
    unlocked: tasks.filter((t) => t.done).map((t) => t.unlocks),
    streak: row.streak || { current: 0, best: 0, lastDate: null },
    milestones: ms.rows.map((r) => ({ key: r.key, label: r.label, achievedAt: r.achieved_at })),
  };
}

/** 推进引导：step（跳到某步）/ skip（跳过）/ complete（完成） */
export async function updateGuide(userId, action, step) {
  await ensureRow(userId);
  const row = await ensureRow(userId);
  let guideStep = row.guide_step;
  let done = row.guide_done;
  let skipped = row.guide_skipped;

  if (action === 'skip') {
    skipped = true;
    done = false;
  } else if (action === 'complete') {
    guideStep = GUIDE_STEPS.length;
    done = true;
    skipped = false;
    await track(userId, 'guide_complete', {});
  } else if (action === 'step') {
    const n = Number(step);
    if (!Number.isInteger(n) || n < 1 || n > GUIDE_STEPS.length) {
      const e = new Error('引导步序无效');
      e.status = 400;
      e.expose = true;
      // 业务规则拒绝（步序越界），非报文非法
      e.business = true;
      throw e;
    }
    guideStep = n;
    if (n >= GUIDE_STEPS.length) {
      done = true;
      await track(userId, 'guide_complete', {});
    }
  } else {
    const e = new Error('不支持的引导操作');
    e.status = 400;
    e.expose = true;
    // 业务规则拒绝（action 不在枚举内），非报文非法
    e.business = true;
    throw e;
  }

  await pool.query(
    'UPDATE onboarding_state SET guide_step=$1, guide_done=$2, guide_skipped=$3, updated_at=now() WHERE user_id=$4',
    [guideStep, done, skipped, userId]
  );
  logger.info('引导状态更新', { userId, action, guideStep, done });
  return getState(userId);
}

/** 每日练习打卡：连续练习 + 里程碑（RQ-15） */
export async function checkin(userId) {
  await ensureRow(userId);
  const row = await ensureRow(userId);
  const today = shToday();
  const streak = advanceStreak(row.streak || {}, today);
  if (streak.repeated) {
    return { ...(await getState(userId)), repeated: true };
  }
  await pool.query('UPDATE onboarding_state SET streak=$1, updated_at=now() WHERE user_id=$2', [
    JSON.stringify({ current: streak.current, best: streak.best, lastDate: streak.lastDate }),
    userId,
  ]);
  await track(userId, 'checkin', { streak: streak.current });

  // 里程碑评定（纯荣誉）
  const tx = await pool.query(
    'SELECT COUNT(*) FILTER (WHERE type=\'SELL\')::int AS sells FROM transactions WHERE user_id=$1',
    [userId]
  );
  const rp = await pool.query(
    "SELECT COUNT(*)::int AS c FROM analytics_events WHERE user_id=$1 AND event='replay_finish'",
    [userId]
  );
  const ctx = { streak, roundCount: tx.rows[0]?.sells || 0, replayCount: rp.rows[0]?.c || 0 };
  const achieved = [];
  for (const m of MILESTONES) {
    if (!m.check(ctx)) continue;
    const { rowCount } = await pool.query(
      'INSERT INTO user_milestones (user_id, key, label) VALUES ($1,$2,$3) ON CONFLICT (user_id, key) DO NOTHING',
      [userId, m.key, m.label]
    );
    if (rowCount > 0) achieved.push({ key: m.key, label: m.label });
  }
  const state = await getState(userId);
  return { ...state, achieved };
}
