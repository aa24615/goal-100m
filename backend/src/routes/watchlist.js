import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';

const router = express.Router();

// RQ-28 自选分组与备注：返回结构化对象（同时保留 code 字段，旧前端逻辑不受影响）
router.get(
  '/watchlist',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT stock_code, group_name, note, created_at FROM watchlist WHERE user_id=$1 ORDER BY group_name ASC, sort ASC, created_at ASC',
      [req.userId]
    );
    res.json(
      rows.map((r) => ({
        code: r.stock_code,
        stockCode: r.stock_code,
        group: r.group_name || '默认',
        note: r.note || '',
        createdAt: r.created_at,
      }))
    );
  })
);

// 分组列表（含每组数量，便于侧边栏分组展示）
router.get(
  '/watchlist/groups',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(group_name,'默认') AS g, COUNT(*)::int AS c
         FROM watchlist WHERE user_id=$1 GROUP BY 1 ORDER BY 1 ASC`,
      [req.userId]
    );
    res.json(rows.map((r) => ({ group: r.g, count: r.c })));
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
    const group = String(req.body?.group || '默认').slice(0, 30) || '默认';
    const note = req.body?.note === undefined || req.body?.note === null ? null : String(req.body.note).slice(0, 500);
    await pool.query(
      `INSERT INTO watchlist (user_id, stock_code, sort, group_name, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, stock_code) DO UPDATE SET
         group_name = EXCLUDED.group_name,
         note = EXCLUDED.note,
         updated_at = now()`,
      [req.userId, code, Date.now() % 100000, group, note]
    );
    logger.info('添加自选', { userId: req.userId, code, group });
    res.json({ ok: true, code, group, note });
  })
);

// RQ-28 修改分组 / 备注（关注理由）
router.patch(
  '/watchlist/:code',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const code = req.params.code.toUpperCase();
    const sets = [];
    const params = [];
    let i = 1;
    if (req.body?.group !== undefined) {
      const g = String(req.body.group || '默认').slice(0, 30) || '默认';
      sets.push(`group_name=$${i++}`);
      params.push(g);
    }
    if (req.body?.note !== undefined) {
      const n = req.body.note === null ? null : String(req.body.note).slice(0, 500);
      sets.push(`note=$${i++}`);
      params.push(n);
    }
    if (sets.length === 0) return res.status(400).json({ error: '没有可更新的字段' });
    params.push(req.userId, code);
    const { rowCount } = await pool.query(
      `UPDATE watchlist SET ${sets.join(', ')}, updated_at=now() WHERE user_id=$${i} AND stock_code=$${i + 1}`,
      params
    );
    if (rowCount === 0) return res.status(404).json({ error: '自选列表中不存在该标的' });
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
