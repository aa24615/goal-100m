// 行情时间机器：回放训练路由（RQ-01 ~ RQ-06）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler } from '../middleware.js';
import { logger } from '../logger.js';
import {
  getReplayRange,
  startSession,
  stepSession,
  tradeInReplay,
  finishSession,
  listSessions,
  compareSessions,
  getSessionState,
} from '../services/replayService.js';
import { track } from '../services/analyticsService.js';

const router = express.Router();

// RQ-01 可回放的历史区间
router.get(
  '/replay/range',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await getReplayRange());
  })
);

// RQ-01 创建回放会话
router.post(
  '/replay/start',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { startSeq, endSeq, capital } = req.body || {};
    const r = await startSession({ userId: req.userId, startSeq, endSeq, capital });
    await track(req.userId, 'replay_start', { sessionId: r.session.id, startSeq, endSeq });
    res.json(r);
  })
);

// 注意：以下两个字面量路由必须放在 '/replay/:id' 之前，
// 否则 'history' / 'compare' 会被 :id 吃掉并解析成 NaN。
// RQ-05 历史成绩列表
router.get(
  '/replay/history',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await listSessions(req.userId, Number(req.query.limit) || 20));
  })
);

// RQ-05 同一区间多次成绩对比
router.get(
  '/replay/compare',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const startSeq = Number(req.query.startSeq);
    const endSeq = Number(req.query.endSeq);
    if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
      return res.status(400).json({ error: '区间参数错误' });
    }
    res.json(await compareSessions({ userId: req.userId, startSeq, endSeq }));
  })
);

// 会话状态（刷新/恢复页面用）
router.get(
  '/replay/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!Number.isInteger(Number(req.params.id))) {
      return res.status(400).json({ error: '会话 ID 无效' });
    }
    res.json(await getSessionState({ userId: req.userId, sessionId: Number(req.params.id) }));
  })
);

// RQ-02 推进 / 回退 / 定位（倍速与暂停由前端播放器控制节奏）
router.post(
  '/replay/:id/step',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { action, seq } = req.body || {};
    if (!['next', 'prev', 'seek', 'hold'].includes(action)) {
      logger.warn('回放推进参数错误', { userId: req.userId, action });
      return res.status(400).json({ error: '不支持的操作' });
    }
    res.json(await stepSession({ userId: req.userId, sessionId: Number(req.params.id), action, seq }));
  })
);

// RQ-03 回放中下单
router.post(
  '/replay/:id/trade',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { code, side, quantity } = req.body || {};
    res.json(await tradeInReplay({ userId: req.userId, sessionId: Number(req.params.id), code, side, quantity }));
  })
);

// RQ-04 结束并出成绩
router.post(
  '/replay/:id/finish',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const r = await finishSession({ userId: req.userId, sessionId: Number(req.params.id) });
    await track(req.userId, 'replay_finish', {
      sessionId: r.session.id,
      returnPct: r.score?.returnPct,
      tradeCount: r.score?.tradeCount,
    });
    res.json(r);
  })
);

export default router;
