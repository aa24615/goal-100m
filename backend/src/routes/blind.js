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
} from '../services/blindService.js';
import { track } from '../services/analyticsService.js';

const router = express.Router();

// RQ-67 一键「随机来一段」：不传 code 即随机抽一段真实历史；传了则走定向片段（便于复测）
router.post(
  '/blind/start',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { bars, liquidOnly, code, startSeq, endSeq } = req.body || {};
    const session = await startBlind({
      userId: req.userId,
      bars,
      liquidOnly: liquidOnly !== false,
      code,
      startSeq,
      endSeq,
    });
    await track(req.userId, 'blind_start', { sessionId: session.id, bars: session.end_seq - session.start_seq + 1 });
    // 训练中绝不返回 stock_code / stock_name，也不返回 seq（seq 可对回交易日历 → 日期）
    res.json({
      id: session.id,
      alias: session.alias,
      status: session.status,
      totalBars: session.end_seq - session.start_seq + 1,
      decisionInterval: DECISION_INTERVAL,
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
