/**
 * 北极星指标（RQ-98）
 *
 * v7 把北极星定为「7 日留存率」。发布 21 小时后实地复核发现：
 *   - 最早 2026-11-02 才有第一个满 7 天的窗口；
 *   - 真实用户约 2 人（6 个账号里 4 个是 demo/测试）。
 * 于是「7 日留存」**名义上可观测、实质上不可读**（F-20）——
 * 继续等一个读不出来的数字，等于继续拍脑袋。
 *
 * 因此本期把北极星临时切换为**首训完成率**：
 *   完成第一次训练决策的新用户 ÷ 注册用户
 * 7 日留存保留在页面并列展示，但必须标注「样本充足后启用」+ 窗口起始日 + 当前 N，
 * 不允许假装已经可读。
 */

import pool from '../db.js';
import { DASHBOARD_RETENTION_WINDOW, retention } from './analyticsService.js';

/** 从 DB 取数计算北极星（RQ-98） */
export async function northStar() {
  const [u, d, r] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total, MIN(created_at) AS first_at FROM users`),
    pool.query(
      `SELECT COUNT(DISTINCT s.user_id)::int AS users
         FROM blind_decisions d JOIN blind_sessions s ON s.id = d.session_id`
    ),
    retention({ days: 30, window: DASHBOARD_RETENTION_WINDOW }),
  ]);
  const row = u.rows[0] || {};
  return summarizeNorthStar({
    registeredUsers: row.total || 0,
    usersWithFirstDecision: d.rows[0]?.users || 0,
    retentionCohortUsers: r?.northStar?.cohortUsers ?? 0,
    retentionValue: r?.northStar?.value ?? null,
    firstUserDate: row.first_at || null,
  });
}

/**
 * 获客实验取数（RQ-105）。
 * 渠道优先取用户行的 acquisition_channel（注册时落定），
 * 缺失时回落到 signup 埋点里携带的 channel，最后归 unknown。
 */
export async function acquisition({ days = 30 } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await pool.query(
    `WITH first_dec AS (
       SELECT s.user_id AS user_id, MIN(d.created_at) AS first_decision_at
         FROM blind_decisions d
         JOIN blind_sessions s ON s.id = d.session_id
        GROUP BY s.user_id
     ),
     first_fin AS (
       SELECT user_id, MIN(finished_at) AS finished_at
         FROM blind_sessions
        WHERE finished_at IS NOT NULL
        GROUP BY user_id
     )
     SELECT u.id AS user_id,
            u.created_at AS registered_at,
            COALESCE(
              NULLIF(u.acquisition_channel, ''),
              (SELECT a.payload->>'channel' FROM analytics_events a
                WHERE a.user_id = u.id AND a.event = 'signup'
                ORDER BY a.created_at ASC LIMIT 1),
              'unknown'
            ) AS channel,
            fd.first_decision_at AS first_decision_at,
            ff.finished_at AS finished_at
       FROM users u
       LEFT JOIN first_dec fd ON fd.user_id = u.id
       LEFT JOIN first_fin ff ON ff.user_id = u.id
      WHERE u.created_at >= now() - ($1 || ' days')::interval`,
    [String(d)]
  );
  return {
    days: d,
    ...summarizeAcquisition(
      rows.map((r) => ({
        userId: r.user_id,
        channel: r.channel,
        registeredAt: r.registered_at,
        firstDecisionAt: r.first_decision_at,
        finishedAt: r.finished_at,
      }))
    ),
  };
}

/** 7 日留存可读所需的最小样本量（低于此值任何留存数字都是噪声） */
export const RETENTION_MIN_SAMPLE = 30;

export function toDateOnly(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * 北极星聚合（纯函数）。
 *
 * @param {object} o
 * @param {number} o.registeredUsers        注册用户数（分母）
 * @param {number} o.usersWithFirstDecision 至少记录过一次训练决策的用户数（分子）
 * @param {number} o.retentionCohortUsers   留存口径已纳入的队列用户数（N）
 * @param {number|null} o.retentionValue    当前 N 日留存率（百分制）
 * @param {Date|string} [o.firstUserDate]   首个用户注册日（用于推算窗口起始）
 * @param {Date|string} [o.now]
 */
export function summarizeNorthStar(o) {
  const {
    registeredUsers,
    usersWithFirstDecision,
    retentionCohortUsers,
    retentionValue,
    firstUserDate,
    now = new Date(),
  } = o && typeof o === 'object' ? o : {};

  const denom = int(registeredUsers);
  const numer = Math.min(int(usersWithFirstDecision), denom);

  const readable = denom > 0;
  const value = readable ? Math.round((numer / denom) * 10000) / 100 : null;

  const cohort = int(retentionCohortUsers);
  const formalReadable = cohort >= RETENTION_MIN_SAMPLE;
  const firstDay = toDateOnly(firstUserDate);
  const base = new Date(now instanceof Date ? now : new Date(now));
  const earliest = firstDay
    ? (() => {
        const d = new Date(`${firstDay}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + DASHBOARD_RETENTION_WINDOW);
        return d.toISOString().slice(0, 10);
      })()
    : null;

  return {
    current: {
      metric: '首训完成率',
      // 目标先做到 > 0，再谈数值 —— 当前基线是 0/4
      target: '先 > 0',
      value,
      numerator: numer,
      denominator: denom,
      readable,
      note: readable
        ? `${numer} / ${denom} 位注册用户完成过至少一次训练决策。`
        : '暂无注册用户，指标不可计算。',
    },
    formal: {
      metric: `${DASHBOARD_RETENTION_WINDOW} 日留存率`,
      enabled: formalReadable,
      value: Number.isFinite(Number(retentionValue)) ? Number(retentionValue) : null,
      sampleSize: cohort,
      minSample: RETENTION_MIN_SAMPLE,
      earliestReadableDate: earliest,
      referenceToday: Number.isNaN(base.getTime()) ? null : base.toISOString().slice(0, 10),
      reason: formalReadable
        ? '样本已充足，留存数字可读。'
        : `队列用户仅 ${cohort} 人，未达 ${RETENTION_MIN_SAMPLE} 人可读下限；最早 ${earliest || '—'} 才有首个完整 ${DASHBOARD_RETENTION_WINDOW} 日窗口。`,
    },
    // 页面必须原样展示这段，避免有人把不可读的数字当结论用
    disclaimer: '首训完成率为当前阶段北极星；7 日留存需样本充足后启用，在此之前不作为决策依据。',
  };
}

/* ------------------------------------------------------------------ *
 * RQ-105 首批真实用户获客实验                                         *
 * ------------------------------------------------------------------ *
 * 现在的第一个瓶颈不是功能、不是发布，是**没有人**（F-19）。
 * 获客实验阶段刻意**只测「是否有人来完成第一次训练」**，不测留存 ——
 * N 太小的时候，留存率只是噪声，早测早误导。
 */

/** 允许的渠道白名单：未登记的渠道一律归入 unknown，避免脏数据污染渠道口径 */
export const ACQUISITION_CHANNELS = ['direct', 'search', 'community', 'referral', 'content'];
export const UNKNOWN_CHANNEL = 'unknown';

export function normalizeChannel(c) {
  const k = String(c || '').trim().toLowerCase();
  return ACQUISITION_CHANNELS.includes(k) ? k : UNKNOWN_CHANNEL;
}

/**
 * 获客实验聚合（纯函数）。
 *
 * @param {Array} rows [{ userId, channel, registeredAt, firstDecisionAt }]
 */
export function summarizeAcquisition(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const byChannel = new Map();

  for (const r of list) {
    const ch = normalizeChannel(r?.channel);
    const g =
      byChannel.get(ch) ||
      { channel: ch, registered: 0, firstDecision: 0, finished: 0, secToFirstDecision: [] };
    g.registered += 1;
    const fd = r?.firstDecisionAt ? new Date(r.firstDecisionAt) : null;
    if (fd && !Number.isNaN(fd.getTime())) {
      g.firstDecision += 1;
      const reg = r?.registeredAt ? new Date(r.registeredAt) : null;
      if (reg && !Number.isNaN(reg.getTime())) {
        g.secToFirstDecision.push(Math.max(0, (fd.getTime() - reg.getTime()) / 1000));
      }
    }
    if (r?.finishedAt) g.finished += 1;
    byChannel.set(ch, g);
  }

  const channels = [...byChannel.values()].map((g) => {
    const med =
      g.secToFirstDecision.length === 0
        ? null
        : (() => {
            const a = g.secToFirstDecision.slice().sort((x, y) => x - y);
            const m = Math.floor(a.length / 2);
            const v = a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
            return Math.round(v * 100) / 100;
          })();
    return {
      channel: g.channel,
      registered: g.registered,
      firstDecision: g.firstDecision,
      finished: g.finished,
      // 本阶段唯一要测的转化：注册 → 完成第一次训练决策
      firstTrainingRate: g.registered > 0 ? Math.round((g.firstDecision / g.registered) * 10000) / 100 : null,
      medianSecToFirstDecision: med,
    };
  });

  const totalRegistered = channels.reduce((s, c) => s + c.registered, 0);
  const totalFirst = channels.reduce((s, c) => s + c.firstDecision, 0);

  return {
    channels: channels.sort((a, b) => b.firstDecision - a.firstDecision),
    total: {
      registered: totalRegistered,
      firstDecision: totalFirst,
      firstTrainingRate: totalRegistered > 0 ? Math.round((totalFirst / totalRegistered) * 10000) / 100 : null,
    },
    // RQ-105 验收：2 周内引入 ≥30 个真实注册
    target: { registered: 30, withinDays: 14 },
    note: '本阶段只测「是否有人来完成第一次训练」，不测留存——N 不足时留存率只是噪声。',
  };
}
