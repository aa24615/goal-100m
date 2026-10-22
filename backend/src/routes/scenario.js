// 剧本训练场路由（RQ-16 ~ RQ-19）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import { listScenarios, getScenarioBars, submitAttempt, listAttempts } from '../services/scenarioService.js';

const router = express.Router();

// RQ-16 关卡列表（含训练目标与难度）
router.get(
  '/scenarios',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await listScenarios(req.userId));
  })
);

// RQ-16 关卡行情（同一剧本每次返回完全一致）
router.get(
  '/scenarios/:key/bars',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await getScenarioBars(req.params.key));
  })
);

// RQ-17 / RQ-18 / RQ-19 提交一次尝试并获取打分、评级与提示
router.post(
  '/scenarios/:key/attempts',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { trades } = req.body || {};
    if (!Array.isArray(trades)) throw businessError('trades 需为数组', 400);
    if (trades.length > 200) throw businessError('单次提交的操作数量过多', 400);
    res.json(await submitAttempt({ userId: req.userId, key: req.params.key, trades }));
  })
);

// RQ-18 历史成绩（最佳记录可复查）
router.get(
  '/scenarios/attempts',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await listAttempts(req.userId, req.query.key ? String(req.query.key) : null, Number(req.query.limit) || 20));
  })
);

export default router;
