// 埋点路由（RQ-35）

import express from 'express';
import pool from '../db.js';
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
import { trainingFunnel } from '../services/trainingFunnelService.js';
import { northStar, acquisition } from '../services/northStarService.js';
import { buildInbox } from '../services/notificationService.js';
import { buildReview } from '../services/reviewService.js';
import { guideFunnel, GUIDE_STEPS } from '../services/firstTrainingService.js';
import { buildSmallSampleFacts } from '../services/smallSampleService.js';
import { buildTierProgress } from '../services/tierProgressService.js';
import { withDevice } from '../services/deviceService.js';
import { auditTelemetry, purgeDuplicates } from '../services/telemetryIntegrityService.js';
import { firstTrainingEffectiveRate } from '../services/effectiveCompletionService.js';
import { externalUserFunnel, userMix, planTestMarks, applyTestMarks } from '../services/testTrafficService.js';
import { markPolluted } from '../services/telemetryIntegrityService.js';
import { buildConclusionPanel } from '../services/intervalConclusionService.js';
import { retentionNotice, guestAgeDays } from '../services/dataRetentionService.js';
import { getSnapshot } from '../market.js';
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
      blind_resume: 'RQ-91 从断点继续一次未完成的训练',
      blind_abandon: 'RQ-91 主动放弃一段未完成的训练',
      first_training_start: 'RQ-92 首访引导首次训练开始',
      first_training_decision: 'RQ-92 首访引导完成第一次训练决策',
      dashboard_view: 'RQ-94 打开指标看板',
      score_card_view: 'RQ-99 查看训练成绩卡',
      score_card_copy: 'RQ-99 复制训练成绩卡文本',
      signup: 'RQ-105 注册（payload.channel 记录来源渠道）',
    },
  });
});

/**
 * 埋点上报。
 * RQ-115：payload 自动补设备维度（mobile / tablet / desktop + 竖横屏），
 * 否则即使有移动端会话，也回答不了「手机端完成率是多少」。
 * 分辨率不入埋点（可用于指纹，且对可用性判断没有增量价值）。
 */
router.post(
  '/analytics/track',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { event, payload } = req.body || {};
    if (!isValidEvent(event)) throw businessError('未知事件类型', 400);
    await track(req.userId, String(event), withDevice(payload, req));
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

/* ---------------------- RQ-96 训练漏斗 ---------------------- */

/**
 * 漏斗：按会话维度给出「开始 → 首次决策 → 持续决策 → 完成」的分步计数、
 * 转化率、开始→首次决策的中位耗时，以及每一次训练分别断在第几步。
 * 这是回答「4 次开始为什么一次决策都没有」的唯一入口。
 */
router.get(
  '/analytics/funnel',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await trainingFunnel({ days: Number(req.query.days) || 30 }));
  })
);

/* ---------------------- RQ-98 北极星 ---------------------- */

/**
 * 北极星：当前阶段为「首训完成率」；7 日留存并列展示但标注「样本充足后启用」。
 * N 不足时把留存数字当结论用，是本期要消除的伪结论之一（F-20）。
 */
router.get(
  '/analytics/north-star',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await northStar());
  })
);

/* ---------------------- RQ-105 获客实验 ---------------------- */

/**
 * 获客实验：按渠道给出注册数与「首训完成率」。
 * 本阶段刻意只测首训转化，不测留存——N 太小时留存率只是噪声。
 */
router.get(
  '/analytics/acquisition',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await acquisition({ days: Number(req.query.days) || 30 }));
  })
);

/* ---------------------- RQ-110 引导路径四步漏斗 ---------------------- */

/**
 * 引导漏斗：进入 → 开始 → 决策 → 结算。
 * v9 的教训是埋点只有两步时**不足以定位断点**（F-33），
 * 因此这里必须四步全给，并把「断点在哪一步」直接算出来。
 */
router.get(
  '/analytics/guide-funnel',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const r = await guideFunnel({ days: Number(req.query.days) || 30 });
    res.json({ ...r, steps: r.steps, stepDefs: GUIDE_STEPS });
  })
);

/* ---------------------- RQ-111 小样本「能说的三件事」 ---------------------- */

/**
 * 小样本页面补位：成本事实 / 行为事实 / 对照事实 + 下一步动作。
 * 硬约束 3：样本门槛不得因「页面太空」被砍——空页面用这三件事补位，
 * 而不是塞进胜率与期望值（那才叫伪结论）。
 */
router.get(
  '/analytics/small-sample',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const priceMap = {};
    for (const q of getSnapshot()) priceMap[q.code] = q.price;
    const review = await buildReview(req.userId, '90d', priceMap);
    const c = review?.checkup ?? {};
    const safe = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    res.json(
      buildSmallSampleFacts({
        sampleSize: safe(c.sampleSize),
        cost: { fee: safe(c.feeTotal), slippage: safe(c.slippageTotal), turnover: safe(c.turnoverTotal) },
        behavior: {
          stopPlanned: safe(c.stopPlanned),
          stopExecuted: safe(c.stopExecuted),
          chaseHigh: safe(c.chaseHigh),
          closed: safe(c.sampleSize),
          medianHoldDays: Number.isFinite(Number(c.medianHoldDays)) ? Number(c.medianHoldDays) : null,
        },
        benchmark: {
          returnPct: Number.isFinite(Number(c.lastReturnPct)) ? Number(c.lastReturnPct) : null,
          buyHoldPct: Number.isFinite(Number(c.lastBuyHoldPct)) ? Number(c.lastBuyHoldPct) : null,
        },
      })
    );
  })
);

/* ---------------------- RQ-117 距下一档还差 N 笔 ---------------------- */

/**
 * 达标进度：把护栏从「拦截」改成「牵引」。
 * 未达标也要显示还差多少、现在能确定什么；达标当日提示一次且可关闭。
 */
router.get(
  '/analytics/tier-progress',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const priceMap = {};
    for (const q of getSnapshot()) priceMap[q.code] = q.price;
    const review = await buildReview(req.userId, '90d', priceMap);
    const dismissed = String(req.query.dismissed || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    res.json(
      buildTierProgress({
        sampleSize: review?.checkup?.sampleSize ?? 0,
        finishedRounds: review?.checkup?.finishedRounds ?? 0,
        dismissed,
      })
    );
  })
);

/* ---------------------- RQ-104 站内提示 ---------------------- */

/**
 * 站内提示：达标提示 + 每周周报提示，各出现一次且可关闭。
 * 关闭状态由前端保存并通过 ?dismissed=key,key 回传，服务端不持久化。
 */
router.get(
  '/analytics/notifications',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const dismissed = String(req.query.dismissed || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const priceMap = {};
    for (const q of getSnapshot()) priceMap[q.code] = q.price;
    const [review, weekly] = await Promise.all([
      buildReview(req.userId, '30d', priceMap),
      weeklyReport(req.userId, { weekDays: 7 }),
    ]);
    res.json(buildInbox({ checkup: review?.checkup ?? null, weekly, dismissed }));
  })
);

/* ---------------------- RQ-143 / RQ-144 埋点可信度 ---------------------- */

/**
 * 埋点审计报告：重复上报 + 埋点↔业务表一致性。
 *
 * 为什么单开一个接口：v12 的全部增长结论都建立在埋点上，而埋点当时是坏的
 * （blind_resume 714 条 / 2 用户）。**先验数据可信度，再看指标**，顺序不能倒。
 */
router.get(
  '/analytics/integrity',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await auditTelemetry({ days: Number(req.query.days) || 30 }));
  })
);

/**
 * 清理历史重复埋点。默认 `dryRun=1` 只报数不删——删除不可逆，
 * 且按 RK-03 的处置原则，优先打标而不是删除。
 */
router.post(
  '/analytics/integrity/purge',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const apply = String(req.query.apply || req.body?.apply || '') === '1';
    res.json(
      await purgeDuplicates({
        dryRun: !apply,
        batch: Number(req.query.batch) || 5000,
      })
    );
  })
);

/* ---------------------- RQ-147 北极星：首训有效完成率 ---------------------- */

/**
 * 北极星临时替换为「首训有效完成率」。
 * 旧口径「首训完成率」已被 0 笔成交的空跑刷成 100%，指标本身作废（F-73），
 * 这里同时返回 formalValue 以便对照说明「为什么 100% 是假的」。
 */
router.get(
  '/analytics/north-star-effective',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await firstTrainingEffectiveRate({ days: Number(req.query.days) || 30 }));
  })
);

/* ---------------------- RQ-148 外部真实用户 ---------------------- */

/**
 * 外部用户漏斗：邀请 → 注册 → 开训 → 有效完成，并给出每一步流失数。
 * 验收「≥5 名外部注册 / ≥2 名有效完成」直接读 `goal.met`，不再靠人工翻表。
 */
router.get(
  '/analytics/external-users',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await externalUserFunnel({ days: Number(req.query.days) || 30 }));
  })
);

/* ---------------------- RQ-149 自测批次标记 ---------------------- */

/** 打标计划预览：只算不改，先让人看清要标谁 */
router.get(
  '/analytics/test-marks',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const [u, s, mix] = await Promise.all([
      pool.query(
        `SELECT id, created_at AS "createdAt" FROM users WHERE created_at >= now() - ($1 || ' days')::interval`,
        [String(days)]
      ),
      pool.query(
        `SELECT id,
                (EXTRACT(EPOCH FROM (finished_at - created_at)))::numeric AS "durationSec",
                COALESCE((score->>'tradeCount')::int, 0) AS "tradeCount",
                finished_at AS "finishedAt",
                status
           FROM blind_sessions
          WHERE created_at >= now() - ($1 || ' days')::interval`,
        [String(days)]
      ),
      userMix({ days }),
    ]);
    const plan = planTestMarks({ users: u.rows, sessions: s.rows });
    res.json({ days, plan, mix });
  })
);

/** 执行打标：必须显式 POST，避免一次误查询就把数据改了 */
router.post(
  '/analytics/test-marks/apply',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.body?.days) || 90));
    const [u, s] = await Promise.all([
      pool.query(
        `SELECT id, created_at AS "createdAt" FROM users WHERE created_at >= now() - ($1 || ' days')::interval`,
        [String(days)]
      ),
      pool.query(
        `SELECT id,
                (EXTRACT(EPOCH FROM (finished_at - created_at)))::numeric AS "durationSec",
                COALESCE((score->>'tradeCount')::int, 0) AS "tradeCount",
                finished_at AS "finishedAt",
                status
           FROM blind_sessions
          WHERE created_at >= now() - ($1 || ' days')::interval`,
        [String(days)]
      ),
    ]);
    const plan = planTestMarks({ users: u.rows, sessions: s.rows });
    const applied = await applyTestMarks(plan);
    // 测试用户产生的埋点一并打标，指标口径统一从 is_test 过滤
    await markPolluted({ days }).catch(() => ({ marked: 0 }));
    res.json({ days, plan, applied });
  })
);

/** 用户构成：真实 / 测试各多少，指标分母是多少（RQ-149 验收） */
router.get(
  '/analytics/user-mix',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await userMix({ days: Number(req.query.days) || 90 }));
  })
);

/* ---------------------- RQ-152 / RQ-153 区间化结论 ---------------------- */

/**
 * 结论面板：样本 <50 笔给「能说的三件事」，≥50 笔给带 95% 区间的结论与达标线。
 * 页面只按 `mode` 渲染，不再自己判断——「页面太空就塞数字进去」是伪结论的复发路径。
 */
router.get(
  '/analytics/conclusion',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const priceMap = {};
    for (const q of getSnapshot()) priceMap[q.code] = q.price;
    const review = await buildReview(req.userId, '90d', priceMap);
    const c = review?.checkup ?? {};
    const n = Number.isFinite(Number(c.sampleSize)) ? Number(c.sampleSize) : 0;
    const safe = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    res.json(
      buildConclusionPanel({
        sampleSize: n,
        expectancyR: Number.isFinite(Number(c.expectancyR)) ? Number(c.expectancyR) : null,
        sigma: Number.isFinite(Number(c.sigma)) ? Number(c.sigma) : null,
        winRate: Number.isFinite(Number(c.winRate)) ? Number(c.winRate) : null,
        avgWin: Number.isFinite(Number(c.avgWinR)) ? Number(c.avgWinR) : null,
        avgLoss: Number.isFinite(Number(c.avgLossR)) ? Number(c.avgLossR) : null,
        disciplineRate: Number.isFinite(Number(c.disciplineRate)) ? Number(c.disciplineRate) / 100 : null,
        smallSample: {
          cost: { fee: safe(c.feeTotal), slippage: safe(c.slippageTotal), turnover: safe(c.turnoverTotal) },
          behavior: {
            stopPlanned: safe(c.stopPlanned),
            stopExecuted: safe(c.stopExecuted),
            chaseHigh: safe(c.chaseHigh),
            closed: n,
            medianHoldDays: Number.isFinite(Number(c.medianHoldDays)) ? Number(c.medianHoldDays) : null,
          },
          benchmark: {
            returnPct: Number.isFinite(Number(c.lastReturnPct)) ? Number(c.lastReturnPct) : null,
            buyHoldPct: Number.isFinite(Number(c.lastBuyHoldPct)) ? Number(c.lastBuyHoldPct) : null,
          },
        },
      })
    );
  })
);

/* ---------------------- RQ-154 数据保留期承诺 ---------------------- */

/**
 * 保留期提示：游客第 5 天起提醒转登录，登录用户明示永久保留。
 * 页面在注册页与训练页都要显示——竞品 8 家无一明确保留期，这是可守的空位。
 */
router.get(
  '/analytics/retention-notice',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { guestTokenFromRequest } = await import('../services/guestService.js');
    const token = guestTokenFromRequest(req);
    const isGuest = !req.userId && Boolean(token);
    let ageDays = null;
    let sessionCount = 0;
    if (isGuest) {
      const g = await guestAgeDays(token).catch(() => ({ ageDays: null, sessionCount: 0 }));
      ageDays = g.ageDays;
      sessionCount = g.sessionCount;
    }
    res.json(retentionNotice({ isGuest, ageDays, sessionCount }));
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
