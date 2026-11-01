/**
 * 发布闸门：埋点一致性对账（RQ-158）与验证留痕（RQ-160）
 *
 * v13 §2 的实测：`blind_finish` 埋点 **4** 条 vs FINISHED 会话 **3** 条。
 * 差 1 条听起来不打紧，但它意味着：**埋点侧与业务侧已经各说各话了**。
 * 漏斗、完成率、北极星都是拿这两个数相除算出来的——分母分子不同源时，
 * 商没有任何意义。而这种不一致在这个项目里**从来没有被人主动发现过**，
 * 每次都是写需求文档时人工翻表才看到。
 *
 * RQ-158 要的就是把这件事变成机器每天自动做：
 *   1. `checkTelemetryConsistency` —— 按 **sessionId** 双向对账（不是单纯比总数）。
 *      比总数只能知道「有几个差」，按 id 对账才能说出「差的是哪一局」，
 *      后者才能被修，前者只能被记下来。
 *   2. `recordVerification` —— 每次发布后验证落库。
 *      RQ-160 的验收是「连续 2 次发布均有验证记录」；
 *      v7 断在提交未部署、v10 断在写完未提交，两次都是**发完没人验**，
 *      而「有没有验」在此之前没有任何证据可查。
 *
 * 设计约束：对账逻辑是纯函数（`reconcileConsistency`），取数在 `checkTelemetryConsistency`
 * 里且接受 `queryFn` 注入，便于无库单测（v8 起的分层约定）。
 */

import { trafficScopeJoin, trafficScopeWhere, DEFAULT_TRAFFIC_SCOPE } from './testIsolationService.js';

/** RQ-160：验收要求「连续 2 次发布均有验证记录」 */
export const REQUIRED_VERIFY_STREAK = 2;

function norm(v) {
  return String(v ?? '').trim();
}

/**
 * 一致性对账的事实来源 SQL。
 * 刻意**只统计真实流量**：测试流量本就会因为打标顺序不同而对不齐，
 * 把它们算进来只会得到一个永远为红、且没人去修的告警。
 */
export const CONSISTENCY_SQL = {
  finishEvents: (days, scope = DEFAULT_TRAFFIC_SCOPE) => `
    SELECT e.id,
           NULLIF(e.payload->>'sessionId','')::int AS session_id
      FROM analytics_events e
      ${trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' })}
     WHERE e.event = 'blind_finish'
       AND ${trafficScopeWhere({ eventAlias: 'e', userAlias: 'u', scope })}
       AND e.created_at >= now() - ($1 || ' days')::interval`,
  finishedSessions: (days, scope = DEFAULT_TRAFFIC_SCOPE) => `
    SELECT s.id AS session_id
      FROM blind_sessions s
      ${trafficScopeJoin({ eventAlias: 's', userAlias: 'u' })}
     WHERE s.status = 'FINISHED'
       AND ${trafficScopeWhere({ eventAlias: 's', userAlias: 'u', scope })}
       AND s.created_at >= now() - ($1 || ' days')::interval`,
};

/**
 * 双向对账（纯函数）。
 *
 * 三个结果类别对应三种完全不同的缺陷：
 *   - `orphanEvents`：埋点记了、业务表没有 → 埋点上报了不存在的会话（或会话被回退了）；
 *   - `missingEvents`：业务表有、埋点没有 → 埋点漏报（用户完成了但没记上）；
 *   - `matched`：两边都有 → 这一局是可信的。
 *
 * 只报总数的话，这两类会被相减抵消掉（一边 +1 一边 -1，总数看着一致）。
 *
 * @param {Array} eventRows   [{id, session_id}]
 * @param {Array} sessionRows [{session_id}]
 */
/**
 * 会话 id 归一。
 *
 * 刻意先判 null/空串再转数字：`Number(null) === 0`、`Number('') === 0` 都是有限数，
 * 用 `Number.isFinite(Number(v))` 兜不住 —— v10 的 `identityOf` 正是这么把游客
 * 算成 userId=0 撞外键的。这里沿用同样的守卫：`NULLIF(...,'')` 从 SQL 侧带来的
 * 空值必须真的变成 null，否则「未携带 sessionId」会被算成「session 0」，
 * 而 0 号会话不存在，于是所有漏报都会被静默归类为「业务表没有这一局」。
 */
function toSessionId(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function reconcileConsistency(eventRows, sessionRows, o = {}) {
  const evs = Array.isArray(eventRows) ? eventRows : [];
  const ses = Array.isArray(sessionRows) ? sessionRows : [];

  const bySid = new Map();
  for (const e of evs) {
    const sid = toSessionId(e?.session_id);
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push(e);
  }
  const sessionIds = new Set(ses.map((s) => toSessionId(s?.session_id)));

  const matched = [];
  const orphanEvents = [];
  for (const [sid, list] of bySid) {
    if (sid != null && sessionIds.has(sid)) matched.push({ sessionId: sid, events: list.length });
    else for (const e of list) orphanEvents.push({ eventId: e?.id ?? null, sessionId: sid, reason: sid == null ? '埋点未携带 sessionId' : '业务表中不存在该会话（或该会话未结算）' });
  }

  const missingEvents = [];
  for (const sid of sessionIds) {
    if (sid == null) continue;
    if (!bySid.has(sid)) missingEvents.push({ sessionId: sid, reason: '会话已结算但无 blind_finish 埋点（漏报）' });
  }

  const ok = orphanEvents.length === 0 && missingEvents.length === 0;
  const detail = ok
    ? `对账一致：${matched.length} 局匹配。`
    : `埋点多 ${orphanEvents.length} 条、业务表多 ${missingEvents.length} 局：${[
        ...orphanEvents.slice(0, 3).map((x) => `event#${x.eventId}(session=${x.sessionId ?? 'null'})`),
        ...missingEvents.slice(0, 3).map((x) => `session#${x.sessionId}`),
      ].join('；')}`;

  return {
    ok,
    eventCount: evs.length,
    sessionCount: sessionIds.size,
    matchedCount: matched.length,
    matched,
    orphanEvents,
    missingEvents,
    diff: evs.length - sessionIds.size,
    detail,
    note: '按 sessionId 双向对账；总数一致但方向相反的错误不会被互相抵消。',
  };
}

/**
 * 发布后校验第 7 项：埋点与业务表一致性。
 * 无 queryFn 时降级为 warn（不阻断，但会明确写出「未校验」）。
 */
export async function checkTelemetryConsistency({ queryFn = null, days = 3650, scope = DEFAULT_TRAFFIC_SCOPE } = {}) {
  if (!queryFn) {
    return { name: 'telemetry-consistency', ok: true, warn: true, detail: '未提供 queryFn，跳过一致性对账（RQ-158 未校验）' };
  }
  const d = Math.min(3650, Math.max(1, Math.floor(Number(days) || 3650)));
  try {
    const [ev, se] = await Promise.all([
      queryFn(CONSISTENCY_SQL.finishEvents(d, scope), [String(d)]),
      queryFn(CONSISTENCY_SQL.finishedSessions(d, scope), [String(d)]),
    ]);
    const r = reconcileConsistency(ev?.rows || [], se?.rows || []);
    return { name: 'telemetry-consistency', ok: r.ok, detail: r.detail, consistency: r };
  } catch (e) {
    return { name: 'telemetry-consistency', ok: false, detail: `一致性对账失败：${e?.message || e}` };
  }
}

/* ------------------------------------------------------------------ *
 * RQ-160 验证留痕                                                      *
 * ------------------------------------------------------------------ */

/**
 * 写一条发布验证记录。
 * `detail` 存整份结果（JSONB），因为验证项会随版本增删——
 * 逐列建字段会导致每次加检查项都要迁移，JSONB 让「检查项演进」不再牵动 schema。
 */
export async function recordVerification({ queryFn = null, gitCommit = null, baseUrl = null, report = {} } = {}) {
  if (!queryFn) return { recorded: false, reason: '未提供 queryFn' };
  const results = Array.isArray(report?.results) ? report.results : [];
  const failed = results.filter((r) => r && r.ok === false);
  try {
    const { rows } = await queryFn(
      `INSERT INTO release_verifications (git_commit, base_url, ok, total, failed, detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING id, run_at`,
      [
        gitCommit ? String(gitCommit).slice(0, 64) : null,
        baseUrl ? String(baseUrl).slice(0, 300) : null,
        Boolean(report?.ok),
        results.length,
        failed.length,
        JSON.stringify(results.map((r) => ({ name: r?.name ?? 'unknown', ok: r?.ok === true, warn: r?.warn === true, detail: String(r?.detail ?? '').slice(0, 500) }))),
      ]
    );
    return { recorded: true, id: rows[0]?.id ?? null, runAt: rows[0]?.run_at ?? null };
  } catch (e) {
    return { recorded: false, reason: e?.message || String(e) };
  }
}

/**
 * 「连续 N 次发布均有验证记录」（纯函数）。
 *
 * 为什么按**不同的 git_commit** 去重计连续：同一个提交重复跑验证脚本是常见的
 * （第一次没过，改完再跑），那不算两次发布；而 `ok:false` 会打断连续——
 * 因为「跑过但没过」不能算「发布已验证」。
 *
 * @param {Array} rows [{git_commit, ok, run_at}] 按 run_at 倒序
 * @param {object} o {required}
 */
export function verificationStreak(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const required = Number.isFinite(Number(o?.required)) ? Math.max(1, Math.floor(Number(o.required))) : REQUIRED_VERIFY_STREAK;

  const seen = new Set();
  let streak = 0;
  for (const r of list) {
    if (r?.ok !== true) break;
    const c = norm(r.git_commit) || `#${streak + 1}`;
    if (seen.has(c)) continue;
    seen.add(c);
    streak += 1;
  }

  return {
    required,
    streak,
    ok: streak >= required,
    commits: [...seen],
    note: streak >= required
      ? `连续 ${streak} 次发布均有验证记录（要求 ≥${required}）。`
      : `连续验证记录仅 ${streak} 次（要求 ≥${required}）：发布后未跑 verifyRelease，或未通过即算发布完成。`,
  };
}

export async function latestVerifications({ queryFn = null, limit = 10 } = {}) {
  if (!queryFn) return { rows: [], reason: '未提供 queryFn' };
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 10)));
  try {
    const { rows } = await queryFn(
      `SELECT id, git_commit, base_url, ok, total, failed, run_at
         FROM release_verifications
        ORDER BY run_at DESC
        LIMIT $1`,
      [n]
    );
    return { rows };
  } catch (e) {
    return { rows: [], reason: e?.message || String(e) };
  }
}

export default {
  reconcileConsistency,
  checkTelemetryConsistency,
  recordVerification,
  verificationStreak,
  latestVerifications,
  CONSISTENCY_SQL,
  REQUIRED_VERIFY_STREAK,
};
