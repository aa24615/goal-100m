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
  dashboard,
  retention,
  DASHBOARD_RETENTION_WINDOW,
} from '../services/analyticsService.js';
import { weeklyReport } from '../services/weeklyReportService.js';
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
      weekly_report_view: '查看每周训练周报',
      prescription_start: '从体检单最坏习惯一键生成并开始定向训练',
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

/* ---------------------- RQ-62 指标看板 ---------------------- */

/**
 * 看板：日/周维度的事件量与活跃用户。
 * 数据保留 180 天（远长于「可回溯 ≥180 天」的验收口径）。
 */
router.get(
  '/analytics/dashboard',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const g = String(req.query.granularity || 'day').toLowerCase();
    res.json(
      await dashboard({
        days: Number(req.query.days) || 30,
        granularity: g === 'week' ? 'week' : 'day',
      })
    );
  })
);

/**
 * 北极星：N 日留存率（默认 7 日）。
 * 未满观察窗口的队列日不纳入平均，否则会把「还没来得及回来」算成流失。
 */
router.get(
  '/analytics/retention',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(
      await retention({
        days: Number(req.query.days) || 30,
        window: Number(req.query.window) || DASHBOARD_RETENTION_WINDOW,
      })
    );
  })
);

/* ---------------------- RQ-86 每周训练周报 ---------------------- */

/**
 * 周报：段数 / 纪律执行率变化 / 距下一档还差几笔。
 * 口径与体检单同源（档位直接复用 checkupService.resolveTier），不另算一套。
 */
router.get(
  '/analytics/weekly',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const r = await weeklyReport(req.userId, { weekDays: days });
    await track(req.userId, 'weekly_report_view', { days }).catch(() => {});
    res.json(r);
  })
);

export default router;
