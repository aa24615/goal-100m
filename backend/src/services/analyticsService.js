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

/** 清理过期埋点（保留 180 天，远长于 90 天回溯要求） */
export async function purgeOldEvents() {
  const { rowCount } = await pool.query(
    `DELETE FROM analytics_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  return rowCount || 0;
}

export { RETENTION_DAYS };
