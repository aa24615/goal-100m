import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './db.js';
import { logger } from './logger.js';
import { asyncHandler } from './middleware.js';

const router = express.Router();
const INITIAL_CAPITAL = 1000000; // 初始虚拟资金 ¥1,000,000

// JWT 密钥：生产环境禁止使用默认密钥，启动时直接失败，避免被自签 token
function resolveSecret() {
  const s = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  if (!s || s === 'dev-secret-change-me') {
    if (isProd) {
      throw new Error('FATAL: 生产环境必须设置 JWT_SECRET 环境变量（禁止使用默认密钥）');
    }
    logger.warn('当前使用默认 JWT 密钥，仅允许在开发环境使用', { env: process.env.NODE_ENV });
    return 'dev-secret-change-me';
  }
  if (s.length < 16) {
    logger.warn('JWT_SECRET 长度不足 16 位，建议更换为更强的随机串');
  }
  return s;
}

const JWT_SECRET = resolveSecret();

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
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

/** 校验 token，返回 userId；无效返回 null（供 WebSocket 鉴权使用） */
export function verifyToken(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return p.sub ?? null;
  } catch {
    return null;
  }
}

const norm = (v) => String(v || '').trim().toLowerCase();

// 用户名与邮箱大小写归一化（配合表达式唯一索引）
// 头像预设 key 白名单（前端对应渲染 emoji + 配色）
const AVATAR_KEYS = new Set([
  'none',
  'panda',
  'fox',
  'tiger',
  'cat',
  'dog',
  'rabbit',
  'owl',
  'monkey',
  'lion',
  'frog',
  'penguin',
  'crab',
]);

// 统一构造返回给前端的用户对象；display_name 缺省回落到用户名
function userPayload(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name ?? u.username,
    avatar: u.avatar ?? null,
    cash: Number(u.cash),
    initialCapital: Number(u.initial_capital),
    createdAt: u.created_at,
  };
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRegister(username, email, password) {
  if (!USERNAME_RE.test(username)) {
    return '用户名需为 3-20 位字母、数字或下划线';
  }
  if (!EMAIL_RE.test(email)) {
    return '邮箱格式不正确';
  }
  if (password.length < 8 || password.length > 32) {
    return '密码长度需为 8-32 位';
  }
  if (/^\d+$/.test(password)) {
    return '密码不能全为数字';
  }
  if (/^(.)\1+$/.test(password)) {
    return '密码不能为同一字符重复';
  }
  return null;
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, email, password } = req.body || {};
    const u = norm(username);
    const em = norm(email);
    if (!u || !em || !password) {
      logger.warn('注册失败: 参数缺失', { username: u, email: em, ip: req.ip });
      return res.status(400).json({ error: '用户名、邮箱、密码均为必填' });
    }
    const invalid = validateRegister(u, em, password);
    if (invalid) {
      logger.warn('注册失败: 校验不通过', { username: u, reason: invalid, ip: req.ip });
      return res.status(400).json({ error: invalid });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (username, email, password_hash, cash, initial_capital) VALUES ($1, $2, $3, $4, $4) RETURNING id, username, email, cash, initial_capital',
        [u, em, hash, INITIAL_CAPITAL]
      );
      const user = rows[0];
      const token = signToken(user.id);
      logger.info('注册成功', { userId: user.id, username: u, email: em, ip: req.ip });
      res.json({ token, user: userPayload(user) });
    } catch (e) {
      if (e.code === '23505') {
        logger.warn('注册失败: 用户名或邮箱已存在', { username: u, email: em, ip: req.ip });
        return res.status(409).json({ error: '用户名或邮箱已被注册' });
      }
      logger.error('注册异常', { username: u, email: em, err: e });
      throw e;
    }
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { account, password } = req.body || {};
    const acc = norm(account);
    if (!acc || !password) {
      logger.warn('登录失败: 参数缺失', { account: acc, ip: req.ip });
      return res.status(400).json({ error: '请输入账号和密码' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(username)=$1 OR lower(email)=$1',
      [acc]
    );
    const user = rows[0];
    if (!user) {
      logger.warn('登录失败: 账号不存在', { account: acc, ip: req.ip });
      return res.status(401).json({ error: '账号不存在' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      logger.warn('登录失败: 密码错误', { account: acc, userId: user.id, ip: req.ip });
      return res.status(401).json({ error: '密码错误' });
    }
    const token = signToken(user.id);
    logger.info('登录成功', { userId: user.id, username: user.username, ip: req.ip });
    res.json({ token, user: userPayload(user) });
  })
);

router.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, username, email, display_name, avatar, cash, initial_capital, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (!rows[0]) {
      logger.warn('查询用户信息失败: 用户不存在', { userId: req.userId });
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json(userPayload(rows[0]));
  })
);

// 个人资料：读取
router.get(
  '/profile',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, username, email, display_name, avatar, cash, initial_capital, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: '用户不存在' });
    res.json(userPayload(rows[0]));
  })
);

// 个人资料：更新（昵称 / 头像）
router.put(
  '/profile',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { displayName, avatar } = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;
    if (displayName !== undefined) {
      const dn = String(displayName).trim();
      if (dn.length === 0 || dn.length > 40) {
        return res.status(400).json({ error: '昵称长度需为 1-40 个字符' });
      }
      sets.push(`display_name=$${i++}`);
      params.push(dn);
    }
    if (avatar !== undefined) {
      const av = avatar === null ? null : String(avatar).trim();
      if (av && av !== 'none' && !AVATAR_KEYS.has(av)) {
        return res.status(400).json({ error: '头像无效' });
      }
      sets.push(`avatar=$${i++}`);
      params.push(av && av !== 'none' ? av : null);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: '没有可更新的字段' });
    }
    params.push(req.userId);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id=$${i} RETURNING id, username, email, display_name, avatar, cash, initial_capital, created_at`,
      params
    );
    logger.info('更新个人资料', { userId: req.userId, fields: Object.keys(req.body || {}) });
    res.json(userPayload(rows[0]));
  })
);

// 修改密码（已登录）
router.post(
  '/account/password',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请填写原密码与新密码' });
    }
    if (newPassword.length < 8 || newPassword.length > 32 || /^\d+$/.test(newPassword)) {
      return res.status(400).json({ error: '新密码需 8-32 位且不能全为数字' });
    }
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: '用户不存在' });
    const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!ok) {
      logger.warn('修改密码失败: 原密码错误', { userId: req.userId, ip: req.ip });
      return res.status(400).json({ error: '原密码不正确' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.userId]);
    logger.info('修改密码成功', { userId: req.userId });
    res.json({ ok: true });
  })
);

// 重置模拟账户：清空持仓与交易记录，资金恢复初始，保留账号与身份
router.post(
  '/account/reset',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM holdings WHERE user_id=$1', [uid]);
      await client.query('DELETE FROM transactions WHERE user_id=$1', [uid]);
      await client.query('DELETE FROM asset_snapshots WHERE user_id=$1', [uid]);
      await client.query('UPDATE users SET cash=$1, initial_capital=$1 WHERE id=$2', [
        INITIAL_CAPITAL,
        uid,
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('重置账户失败', { userId: uid, err: e });
      throw e;
    } finally {
      client.release();
    }
    logger.info('重置模拟账户成功', { userId: uid, capital: INITIAL_CAPITAL });
    res.json({ ok: true, cash: INITIAL_CAPITAL });
  })
);

export default router;
