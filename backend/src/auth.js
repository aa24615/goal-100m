import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './db.js';
import { logger } from './logger.js';
import { asyncHandler } from './middleware.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const INITIAL_CAPITAL = 1000000; // 初始虚拟资金 ¥1,000,000

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
    logger.warn('鉴权失败: 缺少 token', { path: req.originalUrl, ip: req.ip });
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    logger.warn('鉴权失败: token 无效或已过期', {
      path: req.originalUrl,
      ip: req.ip,
      err: e.message,
    });
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      logger.warn('注册失败: 参数缺失', { username, email, ip: req.ip });
      return res.status(400).json({ error: '用户名、邮箱、密码均为必填' });
    }
    if (password.length < 6) {
      logger.warn('注册失败: 密码过短', { username, ip: req.ip });
      return res.status(400).json({ error: '密码至少 6 位' });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (username, email, password_hash, cash, initial_capital) VALUES ($1, $2, $3, $4, $4) RETURNING id, username, email, cash',
        [username, email, hash, INITIAL_CAPITAL]
      );
      const user = rows[0];
      const token = signToken(user.id);
      logger.info('注册成功', { userId: user.id, username, email, ip: req.ip });
      res.json({
        token,
        user: { id: user.id, username: user.username, email: user.email, cash: Number(user.cash) },
      });
    } catch (e) {
      if (e.code === '23505') {
        logger.warn('注册失败: 用户名或邮箱已存在', { username, email, ip: req.ip });
        return res.status(409).json({ error: '用户名或邮箱已被注册' });
      }
      logger.error('注册异常', { username, email, err: e });
      throw e;
    }
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { account, password } = req.body || {};
    if (!account || !password) {
      logger.warn('登录失败: 参数缺失', { account, ip: req.ip });
      return res.status(400).json({ error: '请输入账号和密码' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 OR email=$1', [account]);
    const user = rows[0];
    if (!user) {
      logger.warn('登录失败: 账号不存在', { account, ip: req.ip });
      return res.status(401).json({ error: '账号不存在' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      logger.warn('登录失败: 密码错误', { account, userId: user.id, ip: req.ip });
      return res.status(401).json({ error: '密码错误' });
    }
    const token = signToken(user.id);
    logger.info('登录成功', { userId: user.id, username: user.username, ip: req.ip });
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, cash: Number(user.cash) },
    });
  })
);

router.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, username, email, cash, initial_capital, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (!rows[0]) {
      logger.warn('查询用户信息失败: 用户不存在', { userId: req.userId });
      return res.status(404).json({ error: '用户不存在' });
    }
    const u = rows[0];
    res.json({
      id: u.id,
      username: u.username,
      email: u.email,
      cash: Number(u.cash),
      initialCapital: Number(u.initial_capital),
      createdAt: u.created_at,
    });
  })
);

export default router;
