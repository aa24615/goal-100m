/**
 * 训练漏斗（RQ-96）
 *
 * v8 实地复核发现的硬事实：双盲训练开始 4 次、决策 0 次、完成 0 次，
 * 但当时的埋点只到「开始」——**能看见 3 次开始，却看不出断在第几步、卡了多久**（F-22）。
 *
 * 因此本服务把漏斗按**会话维度**补齐四个节点：
 *   开始 → 首次决策 → 持续决策（≥2 次）→ 完成
 * 并对每个会话给出三件事：
 *   ① 停在第几步（breakpoint）
 *   ② 开始 → 首次决策耗时（对照 RQ-92 的「≤60 秒」验收）
 *   ③ 全程耗时
 *
 * 核心聚合是纯函数（summarizeFunnel），DB 版本只负责取数 —— 便于无库环境单测。
 */

import pool from '../db.js';
import { clampLimit } from '../utils/num.js';

/** 漏斗四步（顺序即「深入程度」，不可调换） */
export const FUNNEL_STEPS = [
  { key: 'start', label: '开始训练', event: 'blind_start' },
  { key: 'first_decision', label: '首次决策', event: 'blind_decision' },
  { key: 'mid_decision', label: '持续决策（≥2 次）', event: 'blind_decision' },
  { key: 'finish', label: '完成训练', event: 'blind_finish' },
];

/** RQ-92 验收口径：开始 → 首次决策的目标上限（秒） */
export const FIRST_DECISION_BUDGET_SEC = 60;

function toMs(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function median(list = []) {
  const arr = list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 1 ? arr[mid] : Math.round(((arr[mid - 1] + arr[mid]) / 2) * 100) / 100;
}

function secBetween(a, b) {
  if (a == null || b == null) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

/**
 * 漏斗聚合（纯函数）。
 *
 * @param {Array} rows [{ sessionId, userId, startedAt, firstDecisionAt, lastDecisionAt, finishedAt, decisions }]
 * @returns {object} 分步计数、转化率、耗时中位数、逐会话断点
 */
export function summarizeFunnel(rows = []) {
  const list = Array.isArray(rows) ? rows : [];

  const sessions = list.map((r) => {
    const started = toMs(r?.startedAt);
    const finished = toMs(r?.finishedAt);
    const decisions = Math.max(0, Math.floor(Number(r?.decisions) || 0));

    // 到达深度：完成 > 持续决策 > 首次决策 > 仅开始
    let reachedIdx = 0;
    if (decisions >= 1) reachedIdx = 1;
    if (decisions >= 2) reachedIdx = 2;
    if (finished != null) reachedIdx = 3;

    const secToFirstDecision = secBetween(started, toMs(r?.firstDecisionAt));
    return {
      sessionId: r?.sessionId ?? null,
      userId: r?.userId ?? null,
      reached: FUNNEL_STEPS[reachedIdx].key,
      reachedLabel: FUNNEL_STEPS[reachedIdx].label,
      // 已到终点就没有断点；否则断点 = 下一步
      breakpoint: reachedIdx >= FUNNEL_STEPS.length - 1 ? null : FUNNEL_STEPS[reachedIdx + 1].key,
      breakpointLabel: reachedIdx >= FUNNEL_STEPS.length - 1 ? null : FUNNEL_STEPS[reachedIdx + 1].label,
      decisions,
      secToFirstDecision,
      secTotal: secBetween(started, finished),
      // RQ-92 验收：首决策是否落在 60 秒预算内
      withinFirstDecisionBudget: secToFirstDecision == null ? null : secToFirstDecision <= FIRST_DECISION_BUDGET_SEC,
    };
  });

  const total = sessions.length;
  const counts = FUNNEL_STEPS.map((s, i) => ({
    ...s,
    count: sessions.filter((x) => FUNNEL_STEPS.findIndex((f) => f.key === x.reached) >= i).length,
  }));

  const reachedIdxOf = (k) => FUNNEL_STEPS.findIndex((f) => f.key === k);
  const atLeast = (i) => sessions.filter((x) => reachedIdxOf(x.reached) >= i).length;

  const startedCount = atLeast(0);
  const firstCount = atLeast(1);
  const finishCount = atLeast(3);

  return {
    steps: counts,
    conversion: {
      total,
      startToFirstDecision: startedCount > 0 ? Math.round((firstCount / startedCount) * 10000) / 100 : null,
      firstToFinish: firstCount > 0 ? Math.round((finishCount / firstCount) * 10000) / 100 : null,
      startToFinish: startedCount > 0 ? Math.round((finishCount / startedCount) * 10000) / 100 : null,
    },
    timing: {
      medianSecToFirstDecision: median(sessions.map((s) => s.secToFirstDecision)),
      medianSecToFinish: median(sessions.map((s) => s.secTotal)),
      budgetSec: FIRST_DECISION_BUDGET_SEC,
      withinBudgetCount: sessions.filter((s) => s.withinFirstDecisionBudget === true).length,
    },
    // 断点分布：直接回答「这几次分别停在第几步」
    breakpoints: FUNNEL_STEPS.map((s) => ({
      key: s.key,
      label: s.label,
      stuck: sessions.filter((x) => x.breakpoint === s.key).length,
    })),
    sessions,
    note: '按会话维度统计；断点 = 该会话未达成的下一步。开始→首次决策的中位耗时对照 RQ-92 的 60 秒预算。',
  };
}

/** 从 DB 取数（会话维度，左连决策表，未决策的会话也会出现在漏斗里） */
export async function trainingFunnel({ days = 30, limit = 500 } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await pool.query(
    `SELECT s.id AS session_id,
            s.user_id AS user_id,
            s.created_at AS started_at,
            s.finished_at AS finished_at,
            MIN(d.created_at) AS first_decision_at,
            MAX(d.created_at) AS last_decision_at,
            COUNT(d.id)::int AS decisions
       FROM blind_sessions s
       LEFT JOIN blind_decisions d ON d.session_id = s.id
      WHERE s.created_at >= now() - ($1 || ' days')::interval
      GROUP BY s.id, s.user_id, s.created_at, s.finished_at
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [String(d), clampLimit(limit, 2000, 500)]
  );
  return {
    days: d,
    ...summarizeFunnel(
      rows.map((r) => ({
        sessionId: r.session_id,
        userId: r.user_id,
        startedAt: r.started_at,
        firstDecisionAt: r.first_decision_at,
        lastDecisionAt: r.last_decision_at,
        finishedAt: r.finished_at,
        decisions: r.decisions,
      }))
    ),
  };
}
