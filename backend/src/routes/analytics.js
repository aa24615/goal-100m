// 埋点路由（RQ-35）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import {
  track,
  statsByDay,
  overview,
  isValidEvent,
  EVENTS,
  recordError,
  recentErrors,
} from '../services/analyticsService.js';
import { optionalAuth } from '../auth.js';

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
      blind_start: '开始一次双盲训练',
      blind_decision: '在双盲训练中记录一次决策',
      blind_finish: '完成一次双盲训练并出成绩',
      checkup_view: '查看交易体检单',
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
/* ---------------------- RQ-75 前端运行时错误上报 ---------------------- */

/**
 * 错误上报**不强制登录**：白屏/崩溃经常发生在 token 尚未注入或已失效的时刻，
 * 若要求鉴权，最该被看见的那一类错误反而一条都收不到。
 * 用 optionalAuth 尽力带上 userId，拿不到就记匿名。
 *
 * 同时做体积限制：body 里的超长文本会被截断，避免把整个页面 DOM 塞进数据库。
 */
router.post(
  '/analytics/error',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind || 'error').slice(0, 24);
    if (!['error', 'unhandledrejection', 'manual'].includes(kind)) {
      throw businessError('未知的上报类型', 400);
    }
    const hasContent =
      (b.message && String(b.message).trim()) || (b.stack && String(b.stack).trim()) || (b.name && String(b.name).trim());
    if (!hasContent) throw businessError('缺少错误信息', 400);

    const r = await recordError({
      userId: req.userId ?? null,
      kind,
      name: b.name,
      message: b.message,
      stack: b.stack,
      url: b.url,
      userAgent: b.userAgent,
      appVersion: b.appVersion,
      context: b.context,
    });
    // 上报侧不需要知道内容，只回 OK；计数与排障走下面的查询接口
    res.json({ ok: true, fingerprint: r.fingerprint });
  })
);

// 排障查询：按指纹聚合最近的前端错误（需登录，避免暴露全站错误明细）
router.get(
  '/analytics/errors',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await recentErrors({ days: Number(req.query.days) || 7, limit: Number(req.query.limit) || 50 }));
  })
);

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
