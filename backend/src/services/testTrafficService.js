/**
 * 自测流量标记与外部真实用户（RQ-149 / RQ-148 / F-84）
 *
 * v12 §0 事实 11：当前「11 个用户」里，5 个集中在 **50 秒内**注册、
 * 3 次训练「完成」集中在 8 秒内（0 笔成交、0.29 秒），却与真实用户混在同一张表里。
 * 在这个前提下，「11 用户」「首训完成率 100%」这两个数字都不可用于任何决策。
 *
 * 本模块做两件事：
 *
 *   1. **自测批次自动标记**（RQ-149）：把「同分钟注册 ≥3 人」与「会话时长 <30 秒」
 *      识别为测试流量，打 `is_test = TRUE`。**打标而非删除**——RK-03 明确要求
 *      历史数据保留可追溯性，且指标默认排除测试流量、但可随时打开核对。
 *   2. **外部真实用户漏斗**（RQ-148）：把「≥5 名外部真实用户注册、≥2 名有效完成」
 *      从一个口头目标变成一条可断言的查询，并给出**每一步的流失点**。
 *
 * 设计约束：
 *   - **判定规则全部是纯函数**：输入行数组，输出要打标的 ID 列表与理由。
 *     这样规则变更可以单测，也不需要为了测试去污染生产库。
 *   - **理由必须落库可读**：`test_reason` 写人话（如 `signup-burst:3/min@2026-10-28T10:05`），
 *     否则三个月后没人知道这一行为什么被排除。
 *   - **默认不改数据**：`applyTestMarks` 必须先 `planTestMarks` 再显式执行。
 */

import pool from '../db.js';
import { logger } from '../logger.js';
import { shanghaiDateKey } from './telemetryIntegrityService.js';

/** 判定阈值（RQ-149 验收标准逐条对应） */
export const TEST_SIGNALS = {
  /** 同一分钟注册 ≥3 人 → 批量自测 */
  signupBurstMinUsers: 3,
  /** 会话从创建到结算 <30 秒 → 空跑 */
  sessionMinDurationSec: 30,
  /** 无成交的「完成」→ 空跑（与 RQ-147 同源，这里用于历史数据打标） */
  minTrades: 1,
};

/** 内部/团队来源判定：这些渠道与 IP 段注册的账号不算外部真实用户 */
export const INTERNAL_CHANNELS = new Set(['self', 'local', 'test', 'dev', 'internal', 'team']);

function int0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function numOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 上海时间的「分」键：用来识别同分钟批量注册 */
export function minuteKeyOf(at) {
  const d = at instanceof Date ? at : new Date(at);
  const t = Number.isFinite(d?.getTime?.()) ? d.getTime() : Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', '@');
}

/**
 * 识别批量注册（纯函数）。
 *
 * @param {Array} rows [{id, createdAt}]
 * @returns {{userIds:number[], groups:Array<{minuteKey:string,count:number,userIds:number[]}>}}
 */
export function classifySignupBursts(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = o && typeof o === 'object' ? o : {};
  const min = Math.max(2, int0(opts.minUsers) || TEST_SIGNALS.signupBurstMinUsers);

  const byMinute = new Map();
  for (const r of list) {
    const id = numOrNull(r?.id ?? r?.user_id);
    if (id == null) continue;
    const k = minuteKeyOf(r?.createdAt ?? r?.created_at);
    if (!byMinute.has(k)) byMinute.set(k, []);
    byMinute.get(k).push(Math.floor(id));
  }

  const groups = [...byMinute.entries()]
    .map(([minuteKey, ids]) => ({ minuteKey, count: ids.length, userIds: ids }))
    .filter((g) => g.count >= min)
    .sort((a, b) => b.count - a.count);

  return { userIds: groups.flatMap((g) => g.userIds), groups };
}

/**
 * 识别空跑会话（纯函数）：时长过短 或 0 笔成交却已结算。
 *
 * 注意 `durationSec` 为 null（时间不可解析）时**不判为测试**——
 * 数据缺失不等于自测，把它算成测试流量会让「真实但数据不全」的局被永久排除。
 */
export function classifyEmptySessions(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = o && typeof o === 'object' ? o : {};
  const minSec = Math.max(0, numOrNull(opts.minDurationSec) ?? TEST_SIGNALS.sessionMinDurationSec);
  const minTrades = Math.max(1, int0(opts.minTrades) || TEST_SIGNALS.minTrades);

  const hits = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const id = numOrNull(r?.id ?? r?.session_id);
    if (id == null) continue;
    const sid = Math.floor(id);
    const dur = numOrNull(r?.durationSec ?? r?.duration_sec);
    const trades = numOrNull(r?.tradeCount ?? r?.trade_count);
    const finished = Boolean(r?.finishedAt ?? r?.finished_at) || String(r?.status || '').toUpperCase() === 'FINISHED';

    if (dur != null && dur < minSec) {
      hits.push({ sessionId: sid, reason: 'empty-run:too-fast', detail: `耗时 ${dur}s < ${minSec}s` });
      continue;
    }
    if (finished && trades != null && trades < minTrades) {
      hits.push({ sessionId: sid, reason: 'empty-run:no-trade', detail: `结算时成交 ${trades} 笔` });
    }
  }
  return { sessionIds: hits.map((h) => h.sessionId), hits };
}

/** 汇总打标计划（纯函数）：只出计划不改数据，便于预览与单测 */
export function planTestMarks({ users = [], sessions = [] } = {}) {
  const burst = classifySignupBursts(users);
  const empty = classifyEmptySessions(sessions);

  const userReasons = burst.userIds.map((id) => ({
    userId: id,
    reason: 'signup-burst',
    detail: `同分钟注册 ${burst.groups.find((g) => g.userIds.includes(id))?.count ?? '≥3'} 人`,
  }));

  return {
    userIds: burst.userIds.slice(),
    sessionIds: empty.sessionIds.slice(),
    userReasons,
    sessionReasons: empty.hits,
    groups: burst.groups,
    total: burst.userIds.length + empty.sessionIds.length,
    note:
      burst.userIds.length + empty.sessionIds.length === 0
        ? '未发现测试流量特征。'
        : `识别到 ${burst.userIds.length} 个测试用户、${empty.sessionIds.length} 局空跑；打标后指标默认排除它们。`,
  };
}

/** 执行打标（唯一会写库的函数，必须先跑 planTestMarks 看清楚） */
export async function applyTestMarks(plan, { queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const p = plan && typeof plan === 'object' ? plan : { userIds: [], sessionIds: [] };
  const users = Array.isArray(p.userIds) ? p.userIds : [];
  const sessions = Array.isArray(p.sessionIds) ? p.sessionIds : [];

  let usersMarked = 0;
  let sessionsMarked = 0;

  if (users.length) {
    const { rowCount } = await q(
      `UPDATE users
          SET is_test = TRUE,
              test_reason = COALESCE(test_reason, 'signup-burst'),
              marked_test_at = now()
        WHERE id = ANY($1::int[]) AND is_test = FALSE`,
      [users]
    );
    usersMarked = rowCount || 0;
  }
  if (sessions.length) {
    const { rowCount } = await q(
      `UPDATE blind_sessions SET is_test = TRUE WHERE id = ANY($1::int[]) AND is_test = FALSE`,
      [sessions]
    );
    sessionsMarked = rowCount || 0;
  }
  if (users.length) {
    // 测试用户产生的埋点一并打标：指标口径统一从 analytics_events.is_test 过滤
    await q(`UPDATE analytics_events SET is_test = TRUE WHERE user_id = ANY($1::int[]) AND is_test = FALSE`, [users]);
  }

  logger.info('自测流量打标完成', { usersMarked, sessionsMarked });
  return { usersMarked, sessionsMarked, total: usersMarked + sessionsMarked };
}

/* ------------------------------------------------------------------ *
 * RQ-148 外部真实用户漏斗                                             *
 * ------------------------------------------------------------------ */

/** 外部用户四步（顺序即漏斗顺序，不可调换） */
export const EXTERNAL_FUNNEL_STEPS = [
  { key: 'invited', label: '发出邀请（链接触达）' },
  { key: 'registered', label: '完成注册' },
  { key: 'started', label: '开始第一次训练' },
  { key: 'effective', label: '有效完成（≥1 笔成交且走完）' },
];

/**
 * 是否外部真实用户（纯函数）。
 *
 * 判定三条，全过才算：
 *   ① 未被打为测试流量；
 *   ② 注册渠道不是内部渠道（self/local/test/dev/internal/team）；
 *   ③ 注册 IP 不是本机/内网段（无 IP 时按 UA 缺失一并视为「无法判定」，不算外部）。
 */
export function isExternalUser(user, o = {}) {
  const u = user && typeof user === 'object' ? user : {};
  const opts = o && typeof o === 'object' ? o : {};
  if (u.is_test === true) return { external: false, reason: 'test-marked', detail: '已打标为测试流量' };

  const ch = String(u.acquisition_channel ?? u.acquisitionChannel ?? '').trim().toLowerCase();
  if (ch && INTERNAL_CHANNELS.has(ch)) {
    return { external: false, reason: 'internal-channel', detail: `渠道 ${ch} 属内部来源` };
  }

  const ip = String(u.signup_ip ?? u.signupIp ?? '').trim();
  if (!ip) return { external: false, reason: 'no-ip', detail: '未记录注册 IP，无法判定是否外部' };

  const teamIps = Array.isArray(opts.teamIps) ? opts.teamIps.map(String) : [];
  if (teamIps.includes(ip)) return { external: false, reason: 'team-ip', detail: `IP ${ip} 在团队 IP 名单内` };

  // 复用 publicAccessService 的判定，避免内网段再写一遍（v10 的教训：两套口径必漂移）
  if (opts.isPublicIpv4 && opts.isLocalHost && !opts.isPublicIpv4(ip)) {
    return { external: false, reason: 'private-ip', detail: `IP ${ip} 非公网地址` };
  }
  return { external: true, reason: 'ok', detail: `渠道 ${ch || 'unknown'}，IP ${ip}` };
}

/**
 * 外部用户漏斗聚合（纯函数）。
 *
 * @param {object} counts { invited, registered, started, effective }
 */
export function summarizeExternalFunnel(counts = {}, o = {}) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const opts = o && typeof o === 'object' ? o : {};
  const goalRegistered = Math.max(1, int0(opts.goalRegistered) || 5);
  const goalEffective = Math.max(1, int0(opts.goalEffective) || 2);

  const steps = EXTERNAL_FUNNEL_STEPS.map((s) => ({ ...s, count: int0(c[s.key]) }));
  const funnel = steps.map((s, i) => {
    const prev = i === 0 ? s.count : steps[i - 1].count;
    return {
      ...s,
      conversionFromPrev: prev > 0 ? Math.round((s.count / prev) * 10000) / 100 : null,
      conversionFromInvited: steps[0].count > 0 ? Math.round((s.count / steps[0].count) * 10000) / 100 : null,
    };
  });

  let dropAt = null;
  for (let i = 1; i < funnel.length; i += 1) {
    if (steps[i - 1].count > 0 && steps[i].count === 0) {
      dropAt = { step: funnel[i].key, label: funnel[i].label, after: funnel[i - 1].key };
      break;
    }
  }

  const registered = int0(c.registered);
  const effective = int0(c.effective);
  const met = registered >= goalRegistered && effective >= goalEffective;

  return {
    steps: funnel,
    dropAt,
    goal: { registered: goalRegistered, effective: goalEffective },
    // 每一步的流失绝对数：验收要求「记录每一步流失点」，只给转化率不够定位
    dropoffs: funnel.slice(1).map((s, i) => ({
      from: funnel[i].key,
      to: s.key,
      lost: Math.max(0, funnel[i].count - s.count),
    })),
    met,
    summary: {
      invited: int0(c.invited),
      registered,
      started: int0(c.started),
      effective,
    },
    note: met
      ? `已达成外部实测目标：${registered} 名注册 / ${effective} 名有效完成。`
      : dropAt
        ? `断点出现在「${dropAt.label}」之前，当前 ${registered}/${goalRegistered} 注册、${effective}/${goalEffective} 有效完成。`
        : `尚未达成：${registered}/${goalRegistered} 注册、${effective}/${goalEffective} 有效完成。`,
  };
}

/**
 * 从 DB 取外部用户漏斗（RQ-148）。
 * 「有效完成」直接读 RQ-147 写入的 `effective_completed`，不再重算 JSON —— 重算会与埋点口径漂移。
 */
export async function externalUserFunnel({ days = 30, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const d = Math.min(365, Math.max(1, Number(days) || 30));

  const { rows: userRows } = await q(
    `SELECT id, acquisition_channel, signup_ip, is_test
       FROM users
      WHERE created_at >= now() - ($1 || ' days')::interval`,
    [String(d)]
  );
  // 动态 import 只为拿到公网 IP 判定，避免与 publicAccessService 形成循环依赖
  const { isPublicIpv4, isLocalHost } = await import('./publicAccessService.js');

  const externalIds = userRows
    .filter((u) => isExternalUser(u, { isPublicIpv4, isLocalHost }).external)
    .map((u) => u.id);

  const registered = externalIds.length;
  let started = 0;
  let effective = 0;

  if (externalIds.length) {
    const { rows: s } = await q(
      `SELECT COUNT(DISTINCT user_id)::int AS started,
              COUNT(DISTINCT user_id) FILTER (WHERE effective_completed = TRUE)::int AS effective
         FROM blind_sessions
        WHERE user_id = ANY($1::int[])
          AND is_test = FALSE`,
      [externalIds]
    );
    started = s[0]?.started || 0;
    effective = s[0]?.effective || 0;
  }

  return {
    days: d,
    externalIds,
    ...summarizeExternalFunnel({ invited: null, registered, started, effective }),
  };
}

/** 用户表里真实/测试的分布（RQ-149 验收「用户表中有明确真实/测试区分」） */
export async function userMix({ days = 90, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const d = Math.min(365, Math.max(1, Number(days) || 90));
  const { rows } = await q(
    `SELECT is_test, COUNT(*)::int AS c
       FROM users
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY is_test`,
    [String(d)]
  );
  const test = rows.find((r) => r.is_test === true)?.c || 0;
  const real = rows.find((r) => r.is_test === false)?.c || 0;
  const total = test + real;
  return {
    days: d,
    total,
    test,
    real,
    testRatio: total > 0 ? Math.round((test / total) * 10000) / 100 : null,
    // 指标默认口径：排除测试流量后的用户数。看板必须显示这个，而不是 total。
    metricDenominator: real,
    note: total > 0
      ? `近 ${d} 天共 ${total} 个账号，其中 ${test} 个被识别为测试流量；所有增长指标默认使用 ${real} 作分母。`
      : '近期内无注册，用户构成不可读。',
  };
}

export { shanghaiDateKey };
