// 埋点路由（RQ-35）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import { track, statsByDay, overview, isValidEvent, EVENTS } from '../services/analyticsService.js';

const router = express.Router();

// 埋点口径文档（自解释，便于口径对齐与回溯）
router.get('/analytics/events', (req, res) => {
  res.json({
    events: EVENTS,
    retentionDays: 180,
    doc: {
      replay_start: '开始一次回放训练',
      replay_finish: '完成一次回放训练（触发时机：成绩生成后）',
      review_view: '查看复盘战绩中心',
      room_join: '加入房间赛',
      room_create: '创建房间赛',
      guide_complete: '完成新手引导',
      task_complete: '完成一个新手任务',
      checkin: '每日练习打卡',
      export_review: '导出复盘报告',
      share_card: '生成战绩分享卡',
    },
  });
});

router.post(
  '/analytics/track',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { event, payload } = req.body || {};
    if (!isValidEvent(event)) throw businessError('未知事件类型', 400);
    await track(req.userId, String(event), payload);
    res.json({ ok: true });
  })
);

// 按日统计（需要登录，避免暴露全站数据）
router.get(
  '/analytics/stats',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { event } = req.query;
    if (!event || !isValidEvent(String(event))) throw businessError('未知事件类型', 400);
    res.json(await statsByDay(String(event), Number(req.query.days) || 30));
  })
);

router.get(
  '/analytics/overview',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await overview(Number(req.query.days) || 7));
  })
);

export default router;
