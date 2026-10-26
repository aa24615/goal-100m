// 双盲训练场路由（RQ-66 双盲 / RQ-67 随机来一段 / RQ-38 决策记录 / RQ-41 成绩）

import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { asyncHandler, parseIdParam, businessError } from '../middleware.js';
import {
  startBlind,
  getBlindSession,
  stepBlind,
  recordDecision,
  tradeInBlind,
  finishBlind,
  listBlindSessions,
  listBlindDecisions,
  resumeBlind,
  abandonBlind,
  DECISION_INTERVAL,
  SEGMENT_TAGS,
  SEGMENT_TAG_ALIASES,
  GRANULARITIES,
  DEFAULT_GRANULARITY,
} from '../services/blindService.js';
import { buildPrescription } from '../services/checkupService.js';
import { track } from '../services/analyticsService.js';
import { buildScoreCard } from '../services/scoreCardService.js';
import { planAccountSync, checkRuleParity, RULES_MANIFEST } from '../services/ruleParityService.js';
import { buildReview } from '../services/reviewService.js';
import { getSnapshot } from '../market.js';

const router = express.Router();

/** RQ-82 片段类型字典 + RQ-81 可用粒度：页面据此渲染筛选项，不硬编码在前端 */
router.get('/blind/tags', authMiddleware, (req, res) => {
  res.json({
    tags: Object.values(SEGMENT_TAGS),
    granularities: GRANULARITIES,
    defaultGranularity: DEFAULT_GRANULARITY,
    // Q6 未确认前分钟级数据不可得，页面必须明示粒度而不是假装支持
    intradayAvailable: GRANULARITIES.some((g) => g.key !== 'day' && g.available),
    note: '当前仅日线（day）有真实行情数据；分钟级数据源接入前，其余粒度会返回 400。',
  });
});

/**
 * RQ-83 训练处方：由体检单的「最坏习惯」生成定向训练计划。
 * 入参 checkup 由前端把 `/review/checkup` 的响应原样带回，
 * 后端不做二次取数 —— 保证处方依据的就是用户眼前那一份体检单。
 */
router.post(
  '/blind/prescription',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const checkup = req.body?.checkup;
    if (!checkup || typeof checkup !== 'object') {
      throw businessError('缺少体检单数据', 400);
    }
    res.json(buildPrescription(checkup));
  })
);

/**
 * 由体检单直接开训：处方生成 + 按标签抽取片段一步到位（RQ-83 的「一键」）。
 * 与 /blind/prescription 的区别是这里会真的创建会话。
 */
router.post(
  '/blind/prescription/start',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const checkup = req.body?.checkup;
    if (!checkup || typeof checkup !== 'object') {
      throw businessError('缺少体检单数据', 400);
    }
    const p = buildPrescription(checkup);
    const session = await startBlind({
      userId: req.userId,
      bars: Number(req.body?.bars) || p.bars,
      tag: p.tag,
      prescriptionKey: p.habitKey || 'default',
      granularity: req.body?.granularity,
    });
    await track(req.userId, 'prescription_start', { sessionId: session.id, habitKey: p.habitKey, tag: p.tag });
    res.json({
      id: session.id,
      alias: session.alias,
      status: session.status,
      totalBars: session.end_seq - session.start_seq + 1,
      decisionInterval: DECISION_INTERVAL,
      prescription: p,
    });
  })
);

// RQ-67 一键「随机来一段」：不传 code 即随机抽一段真实历史；传了则走定向片段（便于复测）
// RQ-82 传 tag 即按特征抽取；RQ-81 传 granularity 指定粒度（当前仅 day 可用）
router.post(
  '/blind/start',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { bars, liquidOnly, code, startSeq, endSeq, tag, granularity } = req.body || {};
    const session = await startBlind({
      userId: req.userId,
      bars,
      liquidOnly: liquidOnly !== false,
      code,
      startSeq,
      endSeq,
      tag,
      granularity: granularity || DEFAULT_GRANULARITY,
    });
    await track(req.userId, 'blind_start', {
      sessionId: session.id,
      bars: session.end_seq - session.start_seq + 1,
      tag: session.segment_tag || null,
      granularity: session.granularity || DEFAULT_GRANULARITY,
    });
    // 训练中绝不返回 stock_code / stock_name，也不返回 seq（seq 可对回交易日历 → 日期）
    // segment_tag 是统计口径不是身份信息，可以返回
    res.json({
      id: session.id,
      alias: session.alias,
      status: session.status,
      totalBars: session.end_seq - session.start_seq + 1,
      decisionInterval: DECISION_INTERVAL,
      segmentTag: session.segment_tag || null,
      granularity: session.granularity || DEFAULT_GRANULARITY,
    });
  })
);

router.get(
  '/blind/history',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await listBlindSessions(req.userId, Number(req.query.limit) || 20));
  })
);

/**
 * RQ-91 断点续做：返回最近一个未结束的会话 + 「上次停在第 N 根」提示。
 * 必须放在 `/blind/:id` 之前，否则会被当成 id=resume 走 400 分支（那正是 F-25 的噪声来源之一）。
 */
router.get(
  '/blind/resume',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const r = await resumeBlind(req.userId);
    if (r.resumable) {
      await track(req.userId, 'blind_resume', {
        sessionId: r.session?.id ?? null,
        cursorIndex: r.hint?.cursorIndex ?? null,
        totalBars: r.hint?.totalBars ?? null,
      });
    }
    res.json(r);
  })
);

/**
 * RQ-101 参数字典（唯一源）：前端一律从这里取标签与别名，
 * 不再各自硬编码，避免 sideways / range 两套写法漂移。
 */
router.get('/blind/dict', authMiddleware, (req, res) => {
  res.json({
    tags: Object.values(SEGMENT_TAGS),
    tagKeys: Object.keys(SEGMENT_TAGS),
    aliases: SEGMENT_TAG_ALIASES,
    granularities: GRANULARITIES,
    defaultGranularity: DEFAULT_GRANULARITY,
    decisionInterval: DECISION_INTERVAL,
    note: '标签以 tagKeys 为唯一规范写法；aliases 中的历史写法会被服务端归一化后接受，不再返回 400。',
  });
});

// RQ-91 放弃这段训练（与「继续」并列的两个出口）
router.post(
  '/blind/:id/abandon',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const s = await abandonBlind(req.userId, id);
    if (!s) throw businessError('没有可放弃的进行中训练', 404);
    await track(req.userId, 'blind_abandon', { sessionId: id });
    res.json({ ok: true, id });
  })
);

/**
 * RQ-99 训练成绩卡：可复制为纯文本的单次结论。
 * sampleSize 取自体检单（buildReview），保证「距下一档还差 N 笔」与体检单同源。
 */
router.get(
  '/blind/:id/card',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.userId, id, { reveal: true });
    if (!r) throw businessError('训练不存在', 404);
    const priceMap = {};
    for (const q of getSnapshot()) priceMap[q.code] = q.price;
    const review = await buildReview(req.userId, '90d', priceMap);
    const card = buildScoreCard({
      session: r.session,
      score: r.session.score || null,
      sampleSize: review?.checkup?.sampleSize ?? 0,
    });
    await track(req.userId, 'score_card_view', { sessionId: id });
    res.json(card);
  })
);

/**
 * RQ-102 训练与真实规则账户同源：先出规则校验与落单计划。
 * 训练未结束（身份仍在遮蔽）时拒绝生成计划——否则落单动作会提前暴露标的（RQ-66）。
 */
router.get(
  '/blind/:id/parity',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.userId, id);
    if (!r) throw businessError('训练不存在', 404);
    const { rows } = await pool.query(
      'SELECT seq, stock_code, stock_name, side, quantity FROM blind_orders WHERE session_id=$1 ORDER BY seq ASC',
      [id]
    );
    res.json({
      manifest: RULES_MANIFEST,
      parity: checkRuleParity({ trainingRules: RULES_MANIFEST.map((x) => x.key), accountRules: RULES_MANIFEST.map((x) => x.key) }),
      plan: planAccountSync({ session: r.session, orders: rows }),
    });
  })
);

router.get(
  '/blind/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.userId, id);
    if (!r) throw businessError('训练不存在', 404);
    res.json({
      session: r.session.status === 'FINISHED'
        ? { ...toSessionDto(r.session), revealed: true }
        : toSessionDto(r.session),
      view: r.view,
      bars: r.maskedBars,
    });
  })
);

function toSessionDto(s) {
  const over = s.status === 'FINISHED';
  return {
    id: s.id,
    alias: s.alias,
    status: s.status,
    // 未结束时不暴露身份字段
    code: over ? s.stock_code : null,
    name: over ? s.stock_name : null,
    // seq 与交易日历一一对应，未结束即等于送出了日期区间
    startSeq: over ? s.start_seq : null,
    endSeq: over ? s.end_seq : null,
    cursorSeq: over ? s.cursor_seq : null,
    totalBars: s.end_seq - s.start_seq + 1,
    cursorIndex: s.cursor_seq - s.start_seq + 1,
    score: s.score,
    createdAt: s.created_at,
    finishedAt: s.finished_at,
    // RQ-82 特征标签 / RQ-81 粒度：均为统计口径，不构成身份泄露
    segmentTag: s.segment_tag || null,
    segmentTagLabel: s.segment_tag ? SEGMENT_TAGS[s.segment_tag]?.label || null : null,
    granularity: s.granularity || DEFAULT_GRANULARITY,
  };
}

router.post(
  '/blind/:id/step',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await stepBlind(req.userId, id, String(req.body?.action || 'next'), req.body?.seq);
    if (!r) throw businessError('训练不存在', 404);
    res.json({ view: r.view, bars: r.maskedBars });
  })
);

// RQ-38 决策记录：未写理由记为「未记录」，计入纪律执行率
router.post(
  '/blind/:id/decision',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const { action, reason, stopPlan, skipped } = req.body || {};
    const r = await recordDecision({ userId: req.userId, sessionId: id, action, reason, stopPlan, skipped });
    if (!r) throw businessError('训练不存在', 404);
    await track(req.userId, 'blind_decision', { sessionId: id, skipped: r.skipped });
    res.json(r);
  })
);

router.get(
  '/blind/:id/decisions',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const list = await listBlindDecisions(req.userId, id);
    if (!list) throw businessError('训练不存在', 404);
    res.json(list);
  })
);

router.post(
  '/blind/:id/trade',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await tradeInBlind({
      userId: req.userId,
      sessionId: id,
      side: req.body?.side,
      quantity: req.body?.quantity,
    });
    if (!r) throw businessError('训练不存在', 404);
    res.json({ ok: true, view: r.view, bars: r.maskedBars });
  })
);

// RQ-41 结束 → 揭示身份并出成绩（含纪律执行率）
router.post(
  '/blind/:id/finish',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await finishBlind(req.userId, id);
    if (!r) throw businessError('训练不存在', 404);
    await track(req.userId, 'blind_finish', {
      sessionId: id,
      returnPct: r.session.score?.returnPct ?? null,
      disciplineRate: r.session.score?.disciplineRate ?? null,
    });
    res.json({ session: toSessionDto(r.session), score: r.session.score, view: r.view });
  })
);

export default router;
