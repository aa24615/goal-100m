// 关键行为埋点服务（RQ-35）
// 四类关键行为：回放训练 / 复盘查看 / 房间赛参与 / 引导完成。
// 埋点为「本轮改造可被度量」的地基，口径固定、可回溯 ≥90 天（清理策略保留 180 天）。

import pool from '../db.js';
import { logger } from '../logger.js';
import { clampLimit } from '../utils/num.js';
import { trafficScopeJoin, trafficScopeWhere, boardScopeOf, DEFAULT_TRAFFIC_SCOPE, classifyIngest } from './testIsolationService.js';

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
  // RQ-86 每周训练周报
  'weekly_report_view',
  // RQ-83 训练处方：从体检单点击「练这个」
  'prescription_start',
  // RQ-91 断点续做：续做与放弃分别计数，用来区分「回来了」和「彻底不来了」
  'blind_resume',
  'blind_abandon',
  // RQ-92 首训直达：首训引导的开始与首次决策
  'first_training_start',
  'first_training_decision',
  // RQ-110 引导路径四步可验证：进入 / 开始 / 决策 / 结算（v9：埋点 0 条，无法定位断点）
  'first_training_enter',
  'first_training_finish',
  // RQ-113 每日一题：参与与完成分开记，用于算连打
  'challenge_join',
  'challenge_finish',
  // RQ-108 免登录练一次：游客局单独计数，避免与注册用户的完成率混算
  'guest_training_start',
  'guest_training_finish',
  // RQ-94 看板与周报入口落地后，入口点击本身要可观测
  'dashboard_view',
  // RQ-99 成绩卡生成与复制
  'score_card_view',
  'score_card_copy',
  // RQ-105 获客归因：注册事件携带渠道
  'signup',
];

const RETENTION_DAYS = 180;

export function isValidEvent(name) {
  return EVENTS.includes(String(name));
}

/**
 * 记录埋点；未知事件直接丢弃（不写库），避免噪声污染统计口径。
 *
 * RQ-157：入库前先判一次「这是不是自测流量」并落进 `is_test`。
 * 放在写入侧而不是事后打标，理由很直接——v12 已经能事后打标了，
 * 但 4521 条事件至今 `is_test` 全为 f，**因为没人去执行打标**。
 * 写入侧判定不依赖任何人记得执行，新产生的污染当天就被分好类。
 *
 * @param {object} [opts] { user, headers, ua, privateIp, isTest }
 */
export async function track(userId, event, payload = {}, opts = {}) {
  if (!isValidEvent(event)) return false;
  const o = opts && typeof opts === 'object' ? opts : {};
  const verdict = classifyIngest({ user: o.user, headers: o.headers, ua: o.ua, privateIp: o.privateIp, isTest: o.isTest, body: payload });
  await pool.query('INSERT INTO analytics_events (user_id, event, payload, is_test) VALUES ($1,$2,$3,$4)', [
    userId ?? null,
    event,
    JSON.stringify(payload || {}),
    verdict.isTest,
  ]);
  logger.debug('埋点已记录', { userId, event, isTest: verdict.isTest });
  return true;
}

/**
 * RQ-157：所有看板查询的默认口径是「真实流量」，测试流量默认不可见。
 * 传 `{ scope: 'all' }` 才能看全量（仅供排障与口径审查）。
 */
function scopeOf(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const raw = String(o.scope ?? DEFAULT_TRAFFIC_SCOPE).toLowerCase();
  return boardScopeOf({ scope: raw });
}

/** 按日/周统计某类事件的次数与人数（RQ-35：可按日/周统计） */
export async function statsByDay(event, days = 30, opts = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const scope = scopeOf(opts);
  const { rows } = await pool.query(
    `SELECT ((e.created_at AT TIME ZONE 'Asia/Shanghai')::date) AS d,
            COUNT(*)::int AS cnt,
            COUNT(DISTINCT e.user_id)::int AS users
       FROM analytics_events e
       ${trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' })}
      WHERE e.event=$1 AND e.created_at >= now() - ($2 || ' days')::interval
        AND ${trafficScopeWhere({ eventAlias: 'e', userAlias: 'u', scope })}
      GROUP BY 1 ORDER BY 1 ASC`,
    [event, String(d)]
  );
  return {
    event,
    days: d,
    scope,
    rows: rows.map((r) => ({ date: String(r.d), count: r.cnt, users: r.users })),
  };
}

/** 汇总视图：四类关键行为一次取回 */
export async function overview(days = 7, opts = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 7));
  const scope = scopeOf(opts);
  const { rows } = await pool.query(
    `SELECT e.event, COUNT(*)::int AS cnt, COUNT(DISTINCT e.user_id)::int AS users
       FROM analytics_events e
       ${trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' })}
      WHERE e.created_at >= now() - ($1 || ' days')::interval
        AND ${trafficScopeWhere({ eventAlias: 'e', userAlias: 'u', scope })}
      GROUP BY e.event ORDER BY cnt DESC`,
    [String(d)]
  );
  return { days: d, scope, events: rows.map((r) => ({ event: r.event, count: r.cnt, users: r.users })) };
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
    [String(d), clampLimit(limit, 200, 50)]
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

/* ------------------------------------------------------------------ *
 * RQ-62 指标看板（北极星 7 日留存的载体）                             *
 * ------------------------------------------------------------------ *
 * 北极星 = 7 日留存率。定义（口径固定，看板与文档必须同源）：
 *   队列日 D 的活跃用户中，在 (D, D+7] 这 7 天内**再次活跃**的比例。
 * 之所以用「再次活跃」而不是「第 7 天当天活跃」，是因为训练是低频行为，
 * 掐第 7 天当天会把绝大多数真实留存误判为流失。
 */

export const DASHBOARD_RETENTION_WINDOW = 7;

function clampDays(d, def, max = 365) {
  const v = Number(d);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(max, Math.floor(v));
}

/** 日/周维度活跃与事件量 */
export async function dashboard({ days = 30, granularity = 'day', scope = DEFAULT_TRAFFIC_SCOPE } = {}) {
  const d = clampDays(days, 30);
  const week = String(granularity).toLowerCase() === 'week';
  const sc = boardScopeOf({ scope });
  const bucket = week
    ? `date_trunc('week', (e.created_at AT TIME ZONE 'Asia/Shanghai'))::date`
    : `((e.created_at AT TIME ZONE 'Asia/Shanghai')::date)`;

  const { rows } = await pool.query(
    `SELECT ${bucket} AS bucket,
            COUNT(*)::int                        AS events,
            COUNT(DISTINCT e.user_id)::int       AS active_users,
            COUNT(*) FILTER (WHERE e.event='blind_start')::int   AS blind_start,
            COUNT(*) FILTER (WHERE e.event='blind_finish')::int  AS blind_finish,
            COUNT(*) FILTER (WHERE e.event='blind_decision')::int AS blind_decision,
            COUNT(*) FILTER (WHERE e.event='checkup_view')::int  AS checkup_view,
            COUNT(*) FILTER (WHERE e.event='replay_finish')::int AS replay_finish
       FROM analytics_events e
       ${trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' })}
      WHERE e.created_at >= now() - ($1 || ' days')::interval
        AND ${trafficScopeWhere({ eventAlias: 'e', userAlias: 'u', scope: sc })}
      GROUP BY 1 ORDER BY 1 ASC`,
    [String(d)]
  );

  return {
    days: d,
    scope: sc,
    granularity: week ? 'week' : 'day',
    retentionDays: RETENTION_DAYS,
    buckets: rows.map((r) => ({
      bucket: r.bucket instanceof Date ? r.bucket.toISOString().slice(0, 10) : String(r.bucket),
      events: r.events,
      activeUsers: r.active_users,
      blindStart: r.blind_start,
      blindFinish: r.blind_finish,
      blindDecision: r.blind_decision,
      checkupView: r.checkup_view,
      replayFinish: r.replay_finish,
    })),
  };
}

/**
 * N 日留存（默认 7 日）。返回每个队列日的留存率，以及窗口内加权平均。
 * 队列日太靠近今天时（不满 N 天窗口）标记为 immature，不纳入平均，
 * 否则会把「还没来得及回来」的用户算成流失，看板天然偏低。
 */
/**
 * 留存聚合（纯函数，抽出来是为了能在无数据库环境下单测口径）。
 *
 * @param {Array} rows  [{ cohort_day, cohort, retained }]
 * @param {object} o    { window, now }
 */
export function summarizeRetention(rows = [], { window = DASHBOARD_RETENTION_WINDOW, now = new Date() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const w = Math.min(30, Math.max(1, Math.floor(Number(window) || DASHBOARD_RETENTION_WINDOW)));
  const today = toDate(now) || new Date();

  const rowsOut = list.map((r) => {
    const cd = toDate(r?.cohort_day) || new Date(0);
    const cohort = Math.max(0, Math.floor(Number(r?.cohort) || 0));
    const retained = Math.max(0, Math.floor(Number(r?.retained) || 0));
    // 未满观察窗口的队列日不计入平均
    const mature = today.getTime() - cd.getTime() >= (w + 1) * 86400 * 1000;
    return {
      cohortDay: cd.toISOString().slice(0, 10),
      cohort,
      retained: Math.min(retained, cohort),
      rate: cohort > 0 ? Math.round((Math.min(retained, cohort) / cohort) * 10000) / 100 : 0,
      mature,
    };
  });

  const matureRows = rowsOut.filter((r) => r.mature && r.cohort > 0);
  const sumCohort = matureRows.reduce((s, r) => s + r.cohort, 0);
  const sumRetained = matureRows.reduce((s, r) => s + r.retained, 0);

  return {
    window: w,
    retentionDays: RETENTION_DAYS,
    northStar: {
      metric: `${w} 日留存率`,
      value: sumCohort > 0 ? Math.round((sumRetained / sumCohort) * 10000) / 100 : null,
      cohortUsers: sumCohort,
      retainedUsers: sumRetained,
      observable: sumCohort > 0,
      note:
        sumCohort > 0
          ? '统计口径：队列日活跃用户在随后 N 日内再次活跃的比例；未满窗口的队列日不计入。'
          : '暂无足够数据（队列用户为 0），北极星当前不可观测。',
    },
    rows: rowsOut,
  };
}

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function retention({ days = 30, window = DASHBOARD_RETENTION_WINDOW, scope = DEFAULT_TRAFFIC_SCOPE } = {}) {
  const d = clampDays(days, 30);
  const w = Math.min(30, Math.max(1, Math.floor(Number(window) || DASHBOARD_RETENTION_WINDOW)));
  const sc = boardScopeOf({ scope });

  const { rows } = await pool.query(
    `WITH act AS (
       SELECT DISTINCT e.user_id, ((e.created_at AT TIME ZONE 'Asia/Shanghai')::date) AS d
         FROM analytics_events e
         ${trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' })}
        WHERE e.user_id IS NOT NULL
          AND e.created_at >= now() - (($1 || ' days')::interval + ($2 || ' days')::interval)
          AND ${trafficScopeWhere({ eventAlias: 'e', userAlias: 'u', scope: sc })}
     )
     SELECT c.d AS cohort_day,
            COUNT(DISTINCT c.user_id)::int AS cohort,
            COUNT(DISTINCT r.user_id)::int AS retained
       FROM act c
       LEFT JOIN act r
         ON r.user_id = c.user_id
        AND r.d > c.d
        AND r.d <= c.d + ($2 || ' days')::interval
      WHERE c.d >= (now() AT TIME ZONE 'Asia/Shanghai')::date - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1 ASC`,
    [String(d), String(w)]
  );

  return { days: d, scope: sc, ...summarizeRetention(rows, { window: w }) };
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
