import express from 'express';
import { asyncHandler } from '../middleware.js';
import { getCachedLeaderboard, PERIODS } from '../services/leaderboardService.js';

const router = express.Router();

router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.period || 'all');
    const period = PERIODS.includes(raw) ? raw : 'all';
    const { data, benchmarkPct } = await getCachedLeaderboard(period);
    res.set('X-Benchmark-Pct', String(benchmarkPct ?? 0));
    res.json(data);
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
