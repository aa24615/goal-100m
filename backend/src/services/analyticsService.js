// 关键行为埋点服务（RQ-35）
// 四类关键行为：回放训练 / 复盘查看 / 房间赛参与 / 引导完成。
// 埋点为「本轮改造可被度量」的地基，口径固定、可回溯 ≥90 天（清理策略保留 180 天）。

import pool from '../db.js';
import { logger } from '../logger.js';

export const EVENTS = [
  'replay_start',
  'replay_finish',
  'review_view',
  'room_join',
  'room_create',
  'guide_complete',
  'task_complete',
  'checkin',
  'export_review',
  'share_card',
  // RQ-66/67/41 双盲训练（RQ-74 要求这些节点真实上报）
  'blind_start',
  'blind_decision',
  'blind_finish',
  // RQ-76 交易体检单查看
  'checkup_view',
];

const RETENTION_DAYS = 180;

export function isValidEvent(name) {
  return EVENTS.includes(String(name));
}

/** 记录埋点；未知事件直接丢弃（不写库），避免噪声污染统计口径 */
export async function track(userId, event, payload = {}) {
  if (!isValidEvent(event)) return false;
  await pool.query('INSERT INTO analytics_events (user_id, event, payload) VALUES ($1,$2,$3)', [
    userId ?? null,
    event,
    JSON.stringify(payload || {}),
  ]);
  logger.debug('埋点已记录', { userId, event });
  return true;
}

/** 按日/周统计某类事件的次数与人数（RQ-35：可按日/周统计） */
export async function statsByDay(event, days = 30) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await pool.query(
    `SELECT ((created_at AT TIME ZONE 'Asia/Shanghai')::date) AS d,
            COUNT(*)::int AS cnt,
            COUNT(DISTINCT user_id)::int AS users
       FROM analytics_events
      WHERE event=$1 AND created_at >= now() - ($2 || ' days')::interval
      GROUP BY 1 ORDER BY 1 ASC`,
    [event, String(d)]
  );
  return {
    event,
    days: d,
    rows: rows.map((r) => ({ date: String(r.d), count: r.cnt, users: r.users })),
  };
}

/** 汇总视图：四类关键行为一次取回 */
export async function overview(days = 7) {
  const d = Math.min(365, Math.max(1, Number(days) || 7));
  const { rows } = await pool.query(
    `SELECT event, COUNT(*)::int AS cnt, COUNT(DISTINCT user_id)::int AS users
       FROM analytics_events
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY event ORDER BY cnt DESC`,
    [String(d)]
  );
  return { days: d, events: rows.map((r) => ({ event: r.event, count: r.cnt, users: r.users })) };
}

/* ------------------------------------------------------------------ *
 * RQ-75 前端运行时错误上报                                            *
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto';

// 脱敏：任何看似身份信息的字段一律不落库。上报侧已做一次，服务端再兜一层，
// 避免将来有人加字段时把 token / 手机号直接写进表里（合规底线）。
const PII_KEYS = /pass|token|secret|authorization|cookie|phone|mobile|email|idcard|身份证|手机|邮箱|密码/i;
const MAX_TEXT = 2000;

export function sanitizeContext(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(ctx)) {
    if (n >= 20) break;
    if (PII_KEYS.test(k)) continue;
    if (v == null) continue;
    const s = typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v);
    out[String(k).slice(0, 40)] = s.slice(0, 300);
    n += 1;
  }
  return out;
}

function clip(v, max) {
  if (v == null) return null;
  return String(v).slice(0, max);
}

/**
 * 错误指纹：name + message + 首帧文件行号。
 * 只取首帧是为了让「同一处 bug 的不同调用栈」聚合到一条，否则堆栈一变就是新指纹。
 */
export function errorFingerprint({ name, message, stack }) {
  const first = String(stack || '').split('\n').find((l) => /at\s/.test(l)) || '';
  const raw = `${clip(name, 60) || ''}|${clip(message, 200) || ''}|${first.trim().slice(0, 160)}`;
  return createHash('sha256').update(raw || 'unknown').digest('hex').slice(0, 32);
}

export async function recordError({ userId, kind, name, message, stack, url, userAgent, appVersion, context }) {
  const fingerprint = errorFingerprint({ name, message, stack });
  const { rows } = await pool.query(
    `INSERT INTO frontend_errors
       (user_id, fingerprint, kind, name, message, stack, url, user_agent, app_version, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
    [
      userId ?? null,
      fingerprint,
      clip(kind, 24) || 'error',
      clip(name, 120),
      clip(message, MAX_TEXT),
      clip(stack, MAX_TEXT),
      clip(url, 512),
      clip(userAgent, 512),
      clip(appVersion, 40),
      JSON.stringify(sanitizeContext(context)),
    ]
  );
  return { id: rows[0].id, fingerprint, createdAt: rows[0].created_at };
}

/** 最近错误（按指纹聚合），供排障查询 */
export async function recentErrors({ days = 7, limit = 50 } = {}) {
  const d = Math.min(180, Math.max(1, Number(days) || 7));
  const { rows } = await pool.query(
    `SELECT fingerprint,
            MIN(name)     AS name,
            MIN(message)  AS message,
            COUNT(*)::int AS cnt,
            COUNT(DISTINCT user_id)::int AS users,
            MAX(created_at) AS last_at,
            MIN(created_at) AS first_at
       FROM frontend_errors
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY fingerprint
      ORDER BY cnt DESC, last_at DESC
      LIMIT $2`,
    [String(d), Math.min(200, Number(limit) || 50)]
  );
  return {
    days: d,
    groups: rows.map((r) => ({
      fingerprint: r.fingerprint,
      name: r.name,
      message: r.message,
      count: r.cnt,
      users: r.users,
      firstAt: r.first_at,
      lastAt: r.last_at,
    })),
  };
}

/** 清理过期埋点（保留 180 天，远长于 90 天回溯要求） */
export async function purgeOldEvents() {
  const { rowCount } = await pool.query(
    `DELETE FROM analytics_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  return rowCount || 0;
}

export { RETENTION_DAYS };
