// 复盘战绩中心 / 能力雷达 / 导出 / 分享卡（RQ-07 ~ RQ-11、RQ-24、RQ-31、RQ-32）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import pool from '../db.js';
import { clampInt } from '../utils/num.js';
import { getSnapshot } from '../market.js';
import {
  buildReview,
  equityVsBenchmark,
  latestReport,
  pairTrades,
  buildScorecard,
  maxDrawdownOf,
  resolvePeriod,
} from '../services/reviewService.js';
import { buildAbilityRadar } from '../services/abilityService.js';
import { transactionsCsv, roundsCsv, reviewHtml, buildShareCard } from '../services/exportService.js';
import { track } from '../services/analyticsService.js';
import { listTransactions } from '../services/transactionService.js';

const router = express.Router();

function priceMap() {
  const m = {};
  for (const q of getSnapshot()) m[q.code] = q.price;
  return m;
}

async function mustUser(userId) {
  const { rows } = await pool.query('SELECT id, display_name, username, cash, initial_capital FROM users WHERE id=$1', [
    userId,
  ]);
  if (!rows[0]) throw businessError('用户不存在', 404);
  return rows[0];
}

async function loadTransactions(userId) {
  const { rows } = await pool.query(
    'SELECT id, stock_code, stock_name, type, quantity, price, amount, fee, realized_pnl, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at ASC',
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    stockCode: r.stock_code,
    stockName: r.stock_name,
    type: r.type,
    quantity: r.quantity,
    price: Number(r.price),
    amount: Number(r.amount),
    fee: Number(r.fee),
    realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
    createdAt: r.created_at,
  }));
}

// RQ-07 / RQ-08 / RQ-10 复盘总览
router.get(
  '/review',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query.period);
    const payload = await buildReview(req.userId, period, priceMap());
    await track(req.userId, 'review_view', { period });
    res.json(payload);
  })
);

// 上次生成的报告（秒回，避免每次重建）
router.get(
  '/review/latest',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const r = await latestReport(req.userId, req.query.period);
    res.json(r || { empty: true });
  })
);

// RQ-76 / RQ-77 / RQ-78 交易体检单：样本门槛 + 5 项决定论指标 + 维度拆解
router.get(
  '/review/checkup',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query.period);
    const review = await buildReview(req.userId, period, priceMap());
    await track(req.userId, 'checkup_view', { period, sufficient: Boolean(review.checkup?.sufficient) });
    res.json(review.checkup);
  })
);

// RQ-09 净值曲线叠加同期大盘
router.get(
  '/review/benchmark',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    res.json(await equityVsBenchmark(req.userId, days));
  })
);

// RQ-24 个人能力雷达
router.get(
  '/review/ability',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query.period);
    const review = await buildReview(req.userId, period, priceMap());
    const u = await mustUser(req.userId);
    const radar = buildAbilityRadar({
      transactions: await loadTransactions(req.userId),
      returnPct: review.returnPct,
      benchmarkPct: review.benchmarkPct,
      equitySeries: [],
      initialCapital: review.initialCapital,
      currentAssets: review.currentAssets,
    });
    res.json({ ...radar, period, returnPct: review.returnPct, benchmarkPct: review.benchmarkPct, owner: u.username });
  })
);

// RQ-11 / RQ-31 导出：复盘报告（csv | html→PDF）
router.get(
  '/review/export',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const fmt = String(req.query.format || 'csv').toLowerCase();
    const period = resolvePeriod(req.query.period);
    const payload = await buildReview(req.userId, period, priceMap());
    const u = await mustUser(req.userId);
    await track(req.userId, 'export_review', { format: fmt, period });

    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="review-${period}.csv"`);
      return res.send(roundsCsv(payload.rounds));
    }
    // html：浏览器可直接打印/另存为 PDF（标准 PDF 内置字体不支持中文）
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="review-${period}.html"`);
    return res.send(reviewHtml(payload, { displayName: u.display_name || u.username }));
  })
);

// RQ-31 交易流水导出
router.get(
  '/transactions/export',
  authMiddleware,
  asyncHandler(async (req, res) => {
    // 导出上限刻意高于分页场景（listTransactions 默认按「一页」封顶 50 条，
    // 若沿用默认值，导出会被静默截断，与这里最大 10000 的意图不符）
    const EXPORT_MAX_SIZE = 10000;
    const size = clampInt(req.query.size, 1, EXPORT_MAX_SIZE, 1000);
    const data = await listTransactions(req.userId, 1, size, EXPORT_MAX_SIZE);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send(transactionsCsv(data.items));
  })
);

// RQ-32 战绩分享卡（脱敏）
router.get(
  '/review/share-card',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query.period);
    const payload = await buildReview(req.userId, period, priceMap());
    const u = await mustUser(req.userId);
    const list = await loadTransactions(req.userId);
    const radar = buildAbilityRadar({
      transactions: list,
      returnPct: payload.returnPct,
      benchmarkPct: payload.benchmarkPct,
      initialCapital: payload.initialCapital,
      currentAssets: payload.currentAssets,
    });
    await track(req.userId, 'share_card', { period });
    res.json(
      buildShareCard({
        displayName: u.display_name || u.username,
        username: u.username,
        returnPct: payload.returnPct,
        excessPct: payload.excessPct,
        radar,
        period,
      })
    );
  })
);

// 纯函数自检端点：便于集成测试直接验证「配对盈亏合计 == 已实现盈亏」
router.post(
  '/review/_pair-check',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { transactions = [] } = req.body || {};
    const { rounds, realizedSum } = pairTrades(transactions, req.body.priceMap || {});
    const dbRealized = transactions.reduce((s, t) => s + (t.type === 'SELL' ? Number(t.realizedPnl || 0) : 0), 0);
    const card = buildScorecard({ rounds, initialCapital: Number(req.body.initialCapital) || 0 });
    res.json({
      realizedSum,
      dbRealized,
      diff: Math.round(Math.abs(dbRealized - realizedSum) * 100) / 100,
      consistent: Math.abs(dbRealized - realizedSum) <= 0.01,
      roundCount: rounds.length,
      scorecard: card,
      maxDrawdown: maxDrawdownOf(req.body.equitySeries || []),
    });
  })
);

export default router;
