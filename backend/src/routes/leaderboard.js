import express from 'express';
import { optionalAuth } from '../auth.js';
import { asyncHandler } from '../middleware.js';
import { getCachedLeaderboard, pickBoard, PERIODS } from '../services/leaderboardService.js';

const router = express.Router();

router.get(
  '/leaderboard',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const raw = String(req.query.period || 'all');
    const period = PERIODS.includes(raw) ? raw : 'all';
    const { data, benchmarkPct } = await getCachedLeaderboard(period);
    // 登录用户即使排在 TOP_N 之外，也始终能看到自己的名次（RQ-34 重置次数同理）
    res.set('X-Benchmark-Pct', String(benchmarkPct ?? 0));
    res.json(pickBoard(data, req.userId ?? null));
  })
);

// 排行榜元信息：同期大盘涨幅（超额收益基准）
router.get(
  '/leaderboard/benchmark',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.period || 'all');
    const period = PERIODS.includes(raw) ? raw : 'all';
    const { benchmarkPct } = await getCachedLeaderboard(period);
    res.json({ period, benchmarkPct: benchmarkPct ?? 0 });
  })
);

export default router;
