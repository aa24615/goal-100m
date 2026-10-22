// 新手引导与成长体系路由（RQ-12 ~ RQ-15）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import { getState, updateGuide, checkin, GUIDE_STEPS } from '../services/onboardingService.js';

const router = express.Router();

// 引导步骤定义（前端首次登录即时渲染，无需等待行为数据）
router.get('/onboarding/steps', (req, res) => {
  res.json({
    steps: GUIDE_STEPS,
    disclaimer: '本平台为模拟交易训练环境，所有行情与资金均为虚构，不构成投资建议',
  });
});

// RQ-12 / RQ-13 / RQ-14 当前引导与任务状态
router.get(
  '/onboarding',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await getState(req.userId));
  })
);

// RQ-12 推进 / 跳过 / 完成引导
router.post(
  '/onboarding/guide',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { action, step } = req.body || {};
    if (!['step', 'skip', 'complete'].includes(action)) {
      throw businessError('不支持的引导操作', 400);
    }
    res.json(await updateGuide(req.userId, action, step));
  })
);

// 重看引导：把步序重置回第 1 步
router.post(
  '/onboarding/restart',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await updateGuide(req.userId, 'step', 1));
  })
);

// RQ-15 每日练习打卡
router.post(
  '/onboarding/checkin',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await checkin(req.userId));
  })
);

export default router;
