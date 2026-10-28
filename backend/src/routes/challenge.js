// 每日一题 · 连打 · 净胜局榜（RQ-113）

import express from 'express';
import { authMiddleware, optionalAuth } from '../auth.js';
import { asyncHandler, businessError, parseIdParam } from '../middleware.js';
import { identityOf, guestTokenFromRequest } from '../services/guestService.js';
import {
  todayChallenge,
  joinChallenge,
  challengeBoard,
  streakOf,
  streakRecordOf,
  buildNetWinBoard,
  buildStreakRecord,
  netWinOf,
  CHALLENGE_MIN_ROUNDS,
  PUBLIC_BOARD_MIN_ACTIVE_USERS,
} from '../services/dailyChallengeService.js';
import { track } from '../services/analyticsService.js';
import { withDevice } from '../services/deviceService.js';

const router = express.Router();

/** 当前请求的归属身份（游客亦可参与每日一题） */
function identityOfReq(req) {
  return identityOf({ userId: req.userId ?? null, guestToken: guestTokenFromRequest(req) });
}

/** 今日一题：全站同题。游客也能看与练（RQ-108 的延续）。 */
router.get(
  '/challenge/today',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const t = await todayChallenge({ now: new Date() });
    const id = identityOfReq(req);
    res.json({
      date: t.date,
      bars: t.bars,
      created: t.created,
      // 训练中绝不返回 stock_code / stock_name / seq —— 这与双盲同一条红线（RQ-66）
      minRounds: CHALLENGE_MIN_ROUNDS,
      streak: id.anonymous ? null : await streakOf(id, new Date()),
      metric: '净胜局',
      note: '跑赢「一直拿着」+1 / 跑输 −1；打满 5 局才上榜，不看绝对收益。',
    });
  })
);

/** 参与今日一题：由已完成的一局结算出净胜局 */
router.post(
  '/challenge/join',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = identityOfReq(req);
    if (id.anonymous) throw businessError('缺少归属身份：登录后参与，或带上游客 token', 400);

    // 复用 parseIdParam：与其余 :id 路由同一套口径，并顺带挡住 1e20 这类
    // 「是整数但超出 int4 区间」的取值 —— 它曾让 joinChallenge 抛 22003 并被兜成 500。
    const sessionId = parseIdParam(req.body?.sessionId);
    if (sessionId === null) throw businessError('训练 ID 无效', 400);

    const netWin = netWinOf({ returnPct: req.body?.returnPct, buyHoldPct: req.body?.buyHoldPct });
    if (netWin == null) {
      throw businessError('缺少本局收益率或买入持有收益率，无法计算净胜局', 400);
    }

    const r = await joinChallenge({ identity: id, sessionId, netWin, now: new Date() });
    if (req.userId) await track(req.userId, 'challenge_join', withDevice({ ...r }, req));
    res.json({ ok: true, ...r });
  })
);

/** 净胜局榜：打满 5 局才上榜，不展示任何绝对收益字段 */
router.get(
  '/challenge/board',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = identityOfReq(req);
    const r = await challengeBoard({
      days: Number(req.query.days) || 30,
      now: new Date(),
      identity: id.anonymous ? null : id,
    });
    res.json(r);
  })
);

/** 个人连打 */
router.get(
  '/challenge/streak',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = identityOfReq(req);
    if (id.anonymous) throw businessError('缺少归属身份', 400);
    res.json(await streakOf(id, new Date()));
  })
);

/**
 * RQ-126 个人连打记录：连打日历 + 与上周的自己比。
 * 这是公榜关闭后的**默认留存钩子**，不是公榜的附属品。
 */
router.get(
  '/challenge/streak/record',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = identityOfReq(req);
    if (id.anonymous) throw businessError('缺少归属身份', 400);
    res.json(await streakRecordOf(id, { now: new Date(), windowDays: Number(req.query.windowDays) || 28 }));
  })
);

/** 连打口径自检（纯函数，无需 DB）：给前端/测试验证日历与周对比的算术 */
router.post('/challenge/streak/check', authMiddleware, (req, res) => {
  const days = Array.isArray(req.body?.days) ? req.body.days : [];
  const o = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
  const now = o.now ? new Date(o.now) : new Date();
  res.json({
    ...buildStreakRecord(days, { ...o, now }),
    publicBoardMinUsers: PUBLIC_BOARD_MIN_ACTIVE_USERS,
    note: 'thisWeek / lastWeek / delta 由日历推导；calendar 长度恒等于 windowDays。',
  });
});

/**
 * 榜单口径自检（纯函数，无需 DB）：
 * 用于验证「未达 5 局不上榜」与「不出现绝对收益字段」这两条硬约束。
 */
router.post('/challenge/board/check', authMiddleware, (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const board = buildNetWinBoard(entries, { minRounds: Number(req.body?.minRounds) || CHALLENGE_MIN_ROUNDS });
  const serialized = JSON.stringify(board);
  res.json({
    ...board,
    guard: {
      // 硬约束 6：榜单序列化结果里不得出现任何收益率字段
      hasReturnField: /returnPct|return_pct|收益率|收益排名/.test(serialized),
      minRounds: board.minRounds,
      note: 'hasReturnField 必须为 false；出现即为硬约束 6 被破坏。',
    },
  });
});

export default router;
