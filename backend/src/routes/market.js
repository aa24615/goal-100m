import express from 'express';
import { getSnapshot, getDetail, getSummary, getMarketStatus, forceNextSession } from '../market.js';
import { authMiddleware } from '../auth.js';
import { asyncHandler } from '../middleware.js';

const router = express.Router();

router.get('/stocks', (req, res) => {
  res.json(getSnapshot());
});

router.get('/market/summary', (req, res) => {
  res.json(getSummary());
});

// 交易日历 / 行情引擎状态
router.get('/market/status', (req, res) => {
  res.json(getMarketStatus());
});

// 演示用：强制收盘结算并进入下一交易日
router.post(
  '/market/next-day',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await forceNextSession());
  })
);

router.get('/stocks/:code', (req, res) => {
  const d = getDetail(req.params.code.toUpperCase());
  if (!d) return res.status(404).json({ error: '股票不存在' });
  res.json(d);
});

export default router;
