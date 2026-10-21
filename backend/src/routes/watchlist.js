import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';

const router = express.Router();

router.get(
  '/watchlist',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT stock_code FROM watchlist WHERE user_id=$1 ORDER BY sort ASC, created_at ASC',
      [req.userId]
    );
    res.json(rows.map((r) => r.stock_code));
  })
);

router.post(
  '/watchlist',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code || '').toUpperCase();
    if (!code) {
      logger.warn('添加自选失败: 缺少代码', { userId: req.userId });
      return res.status(400).json({ error: '缺少股票代码' });
    }
    const exists = await pool.query('SELECT 1 FROM stocks WHERE code=$1', [code]);
    if (exists.rows.length === 0) {
      logger.warn('添加自选失败: 股票不存在', { userId: req.userId, code });
      return res.status(404).json({ error: '股票不存在' });
    }
    await pool.query(
      'INSERT INTO watchlist (user_id, stock_code, sort) VALUES ($1, $2, $3) ON CONFLICT (user_id, stock_code) DO NOTHING',
      [req.userId, code, Date.now() % 100000]
    );
    logger.info('添加自选', { userId: req.userId, code });
    res.json({ ok: true, code });
  })
);

router.delete(
  '/watchlist/:code',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const code = req.params.code.toUpperCase();
    await pool.query('DELETE FROM watchlist WHERE user_id=$1 AND stock_code=$2', [req.userId, code]);
    logger.info('移除自选', { userId: req.userId, code });
    res.json({ ok: true, code });
  })
);

export default router;
