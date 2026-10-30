/**
 * 「有效完成」门槛（RQ-147 / F-73 / F-80）
 *
 * v12 头号发现：`blind_sessions` id=8 创建 18:31:15.736 → 完成 18:31:16.026，
 * **间隔 0.29 秒**，score 里 `tradeCount: 0`、`durationSec: 0`、`feeTotal: 0`、
 * `decisionPoints: 1`、`disciplineRate: 100`。
 * 北极星「首训完成率」= 3/3 = **100%**，而分子里没有一次是真正的训练。
 *
 * 一句话：**闭环通了，但通的是一根空管——水还没进来，水表已经在转。**
 *
 * 因此「完成」分两层：
 *   ① **形式完成**（既有 RQ-109 口径）：会话 FINISHED 且已出成绩卡；
 *   ② **有效完成**（本期新增）：在 ① 之上再加三条硬门槛。
 * 北极星只读 ②；① 仍然保留，因为它回答的是「系统有没有跑通」，
 * 两者混用正是本期指标被刷满的根因。
 *
 * 设计约束：
 *   - **门槛是常量而不是散落在各处的 if**：三处（埋点、北极星、成绩卡）共用同一判定，
 *     避免「埋点算有效、成绩卡算完成」再次漂移（F-32 同类错误）。
 *   - **未达门槛时给动作，不给数字**：出「再来一次」而不是出一张 0 笔的成绩卡——
 *     0 笔的成绩卡里 `纪律执行率 100%` 是自相矛盾的展示（F-80）。
 */

import pool from '../db.js';
import { isCompleted } from './completionContract.js';

/** 有效完成的三条硬门槛（验收标准逐条对应） */
export const EFFECTIVE_RULES = {
  version: 'v12',
  /** 至少 1 笔成交：0 笔成交的局没有训练内容 */
  minTrades: 1,
  /** 至少 10 秒：0.29 秒完成一局只可能是脚本或误触 */
  minDurationSec: 10,
  /** 必须走完全部 K 线：半途结算拿到的收益不是这一局的成绩 */
  requireFullBars: true,
  definition: '有效完成 = 已结算 且 至少 1 笔成交 且 走完全部 K 线 且 耗时不少于 10 秒',
};

/** 未达门槛时页面要说的三句话（顺序即展示顺序） */
export const BLOCKER_TEXT = {
  not_finished: {
    title: '这一局还没结算',
    body: '继续走到最后一根 K 线，结算后才会生成成绩卡。',
    cta: '继续这一局',
    action: 'continue',
  },
  no_trade: {
    title: '这一局还没有成交',
    body: '全程观望也算走完，但不计入「有效完成」——没有成交就没有可核对的训练结果。',
    cta: '再来一局，至少做一次买卖',
    action: 'retry',
  },
  too_fast: {
    title: '这一局用时太短',
    body: '不到 10 秒就结束的一局通常只是误触，不计入有效完成。',
    cta: '再来一局',
    action: 'retry',
  },
  partial_bars: {
    title: '这一局没有走完',
    body: '中途结算拿到的收益不代表这一局的完整表现，需走到最后一根。',
    cta: '继续走到最后一根',
    action: 'continue',
  },
};

function int0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function numOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 会话耗时（秒）：优先取 score.durationSec，缺失时用 created_at/finished_at 推算。
 *
 * 为什么两个来源都要：历史 score 里 durationSec 恒为 0（v12 的 id=8 就是），
 * 只看它会把「真走了 5 分钟」也判成空跑；而只看时间戳又会在 score 已修正时不够准。
 */
export function durationSecOf(session, score) {
  const s = session && typeof session === 'object' ? session : {};
  const sc = score && typeof score === 'object' ? score : {};
  const fromScore = numOrNull(sc.durationSec);
  if (fromScore != null && fromScore > 0) return fromScore;

  const a = s.created_at ?? s.createdAt ?? null;
  const b = s.finished_at ?? s.finishedAt ?? null;
  if (!a || !b) return fromScore == null ? null : fromScore;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb < ta) return fromScore == null ? null : fromScore;
  return Math.round(((tb - ta) / 1000) * 100) / 100;
}

/** 已推进根数 / 总根数：缺 seq 时返回 null，不猜 */
export function barProgressOf(session) {
  const s = session && typeof session === 'object' ? session : {};
  const start = numOrNull(s.start_seq ?? s.startSeq);
  const end = numOrNull(s.end_seq ?? s.endSeq);
  const cursor = numOrNull(s.cursor_seq ?? s.cursorSeq);
  if (start == null || end == null) return { advanced: null, total: null, full: null };
  const total = end - start + 1;
  if (cursor == null) return { advanced: null, total, full: null };
  const advanced = cursor - start + 1;
  return { advanced, total, full: advanced >= total };
}

/**
 * 判定「有效完成」（纯函数）。
 *
 * @param {object} o
 * @param {object} [o.session]    blind_sessions 行
 * @param {object} [o.score]      session.score
 * @param {number} [o.orderCount] blind_orders 行数（不给时取 score.tradeCount）
 */
export function evaluateEffectiveCompletion(o) {
  const src = o && typeof o === 'object' ? o : {};
  const session = src.session && typeof src.session === 'object' ? src.session : {};
  // 注意：这里不能写成 `const score = src.score && typeof score === 'object' ? ... : ...`
  // —— 在初始化器里引用同名 const 会命中 TDZ，`typeof` 对 TDZ 变量抛 ReferenceError
  // （与「未声明变量返回 undefined」不同）。只读展示类函数最怕这种隐蔽崩溃。
  const scoreFromSession = session.score && typeof session.score === 'object' ? session.score : null;
  const scoreFromArg = src.score && typeof src.score === 'object' ? src.score : null;
  const sc = scoreFromArg || scoreFromSession || {};

  const completed = isCompleted(session);
  const status = String(session.status || '').toUpperCase();

  const tradeFromScore = numOrNull(sc.tradeCount);
  const tradeCount = src.orderCount == null ? (tradeFromScore == null ? 0 : int0(tradeFromScore)) : int0(src.orderCount);
  const durationSec = durationSecOf(session, sc);
  const progress = barProgressOf(session);

  const blockers = [];

  if (!completed || status !== 'FINISHED') {
    blockers.push({
      key: 'not_finished',
      ...BLOCKER_TEXT.not_finished,
      detail: `当前状态 ${status || '未知'}；完成口径：${isCompleted ? '结算并出成绩卡' : '结算并出成绩卡'}。`,
    });
  }
  if (tradeCount < EFFECTIVE_RULES.minTrades) {
    blockers.push({
      key: 'no_trade',
      ...BLOCKER_TEXT.no_trade,
      detail: `本局成交 ${tradeCount} 笔，门槛 ${EFFECTIVE_RULES.minTrades} 笔。`,
    });
  }
  if (durationSec != null && durationSec < EFFECTIVE_RULES.minDurationSec) {
    blockers.push({
      key: 'too_fast',
      ...BLOCKER_TEXT.too_fast,
      detail: `本局耗时 ${durationSec} 秒，门槛 ${EFFECTIVE_RULES.minDurationSec} 秒。`,
    });
  }
  if (EFFECTIVE_RULES.requireFullBars && progress.full === false) {
    blockers.push({
      key: 'partial_bars',
      ...BLOCKER_TEXT.partial_bars,
      detail: `推进 ${progress.advanced}/${progress.total} 根。`,
    });
  }

  const effective = completed && blockers.length === 0;

  return {
    /** 形式完成（既有口径）：系统跑通了没有 */
    completed,
    /** 有效完成（本期口径）：跑通了且里面有东西 */
    effective,
    status: status || null,
    tradeCount,
    durationSec,
    bars: progress,
    blockers,
    blockerKeys: blockers.map((b) => b.key),
    rules: EFFECTIVE_RULES,
    /**
     * 成绩卡闸门：未达有效完成时**不出成绩卡**，改出引导（F-80）。
     * `completed` 仍为 true 的一并解释清楚，避免用户以为系统坏了。
     */
    scoreCard: effective
      ? { show: true, reason: null }
      : {
          show: false,
          reason: blockers[0]?.key || 'not_finished',
          fallback: {
            title: blockers[0]?.title || '这一局还没结算',
            body: blockers[0]?.body || '走到最后一根并至少成交一次，才会生成成绩卡。',
            cta: blockers[0]?.cta || '再来一局',
            action: blockers[0]?.action || 'retry',
          },
        },
    note: effective
      ? '本局满足有效完成门槛，计入首训有效完成率。'
      : `本局不计入有效完成：${blockers.map((b) => b.title).join('；') || '未结算'}。`,
  };
}

/**
 * 北极星：首训**有效**完成率（纯函数）。
 *
 * 与 `completionContract.completionRate` 的区别：分母分子都要**排除测试流量**，
 * 且分子只认有效完成。当前值是 0% —— 因为此前 3/3 的 100% 全部是空跑。
 */
export function effectiveCompletionRate(o) {
  const src = o && typeof o === 'object' ? o : {};
  const started = int0(src.started);
  const finished = int0(src.finished);
  const effective = Math.min(int0(src.effective), finished);
  const excluded = Math.max(0, int0(src.testExcluded));

  return {
    metric: '首训有效完成率',
    definition: EFFECTIVE_RULES.definition,
    value: started > 0 ? Math.round((effective / started) * 10000) / 100 : null,
    /** 对照：旧口径（形式完成），用来说明「为什么 100% 是假的」 */
    formalValue: started > 0 ? Math.round((finished / started) * 10000) / 100 : null,
    numerator: effective,
    denominator: started,
    finished,
    testExcluded: excluded,
    // N<5 时数字不可读：宁可说「样本不足」，也不要让 1/1=100% 再次误导决策（F-73）
    readable: started >= (src.minSample ?? 5),
    minSample: src.minSample ?? 5,
    note:
      started === 0
        ? '尚无首训开始记录，北极星不可观测。'
        : started < (src.minSample ?? 5)
          ? `样本 ${started} < ${src.minSample ?? 5}，数字只作参考，不作为达标判断。`
          : `排除测试流量 ${excluded} 后：有效完成 ${effective}/${started}。`,
  };
}

/* ------------------------------------------------------------------ *
 * DB 侧：北极星「首训有效完成率」                                      *
 * ------------------------------------------------------------------ */

/**
 * 取首训有效完成率（RQ-147 北极星）。
 *
 * 三条口径都是硬要求，缺一不可：
 *   ① 分子只认 `effective_completed = TRUE`（≥1 笔成交 + 走完 + ≥10 秒）；
 *   ② 分母与分子都排除测试流量（`is_test`）；
 *   ③ N < 5 时 `readable=false`，不允许拿它下结论（F-73 的复发路径就是 1/1=100%）。
 */
export async function firstTrainingEffectiveRate({ days = 30, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const d = Math.min(365, Math.max(1, Number(days) || 30));

  const { rows: ev } = await q(
    `SELECT e.event, COUNT(DISTINCT e.user_id)::int AS c
       FROM analytics_events e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.event IN ('first_training_start','first_training_finish')
        AND e.is_test = FALSE
        AND COALESCE(u.is_test, FALSE) = FALSE
        AND e.user_id IS NOT NULL
        AND e.created_at >= now() - ($1 || ' days')::interval
      GROUP BY e.event`,
    [String(d)]
  );
  const counts = {};
  for (const r of ev) counts[r.event] = r.c;

  const { rows: eff } = await q(
    `SELECT COUNT(DISTINCT s.user_id)::int AS c
       FROM blind_sessions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.effective_completed = TRUE
        AND s.is_test = FALSE
        AND COALESCE(u.is_test, FALSE) = FALSE
        AND s.user_id IS NOT NULL
        AND s.created_at >= now() - ($1 || ' days')::interval`,
    [String(d)]
  );

  const { rows: tst } = await q(
    `SELECT COUNT(DISTINCT e.user_id)::int AS c
       FROM analytics_events e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.is_test = TRUE OR COALESCE(u.is_test, FALSE) = TRUE`,
    []
  );

  return {
    days: d,
    ...effectiveCompletionRate({
      started: counts.first_training_start || 0,
      finished: counts.first_training_finish || 0,
      effective: eff[0]?.c || 0,
      testExcluded: tst[0]?.c || 0,
    }),
    rules: EFFECTIVE_RULES,
  };
}

/**
 * 埋点守卫：决定这条 `first_training_finish` 该不该发。
 *
 * 为什么必须有：埋点一旦发出就进了分母，事后清洗只能改数据库、改不了别人已经看到的数。
 * 因此在**发送前**判定（调用方：routes/blind.js）。
 */
export function allowFinishTelemetry(evaluation) {
  const e = evaluation && typeof evaluation === 'object' ? evaluation : {};
  return {
    send: e.effective === true,
    reason: e.effective ? 'effective' : `blocked:${(e.blockerKeys || []).join(',') || 'not_finished'}`,
    // 被拦下时改发一个可诊断的事件，避免「没了埋点就不知道发生了什么」
    alternative: e.effective ? null : 'blind_finish_invalid',
  };
}
