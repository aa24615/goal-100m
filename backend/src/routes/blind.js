// 双盲训练场路由（RQ-66 双盲 / RQ-67 随机来一段 / RQ-38 决策记录 / RQ-41 成绩）

import express from 'express';
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
  DECISION_INTERVAL,
  SEGMENT_TAGS,
  GRANULARITIES,
  DEFAULT_GRANULARITY,
} from '../services/blindService.js';
import { buildPrescription } from '../services/checkupService.js';
import { track } from '../services/analyticsService.js';

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
