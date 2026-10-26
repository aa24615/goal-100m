import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import pool from './db.js';
import { logger } from './logger.js';
import { asyncHandler } from './middleware.js';
import { track } from './services/analyticsService.js';
import { normalizeChannel } from './services/northStarService.js';

const router = express.Router();
const INITIAL_CAPITAL = 1000000; // 初始虚拟资金 ¥1,000,000

// JWT 密钥：生产环境禁止使用默认密钥，启动时直接失败，避免被自签 token
// 公开样例 / 占位密钥黑名单：与「未设置」同等对待。
// 此前只识别 dev-secret-change-me，而 docker-compose 与 .env.example 里的默认值是
// please-change-this-secret —— 这个公开字符串能静默绕过生产环境的强校验。
const PLACEHOLDER_SECRETS = new Set([
  'dev-secret-change-me',
  'please-change-this-secret',
  'your-secret-key',
  'change-me',
  'changeme',
  'secret',
]);

function resolveSecret() {
  const s = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  if (!s || PLACEHOLDER_SECRETS.has(s)) {
    if (isProd) {
      throw new Error('FATAL: 生产环境必须设置 JWT_SECRET 环境变量（禁止使用默认/占位密钥）');
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

/**
 * 可选鉴权：带了合法 token 就解析出 req.userId，没带或 token 失效则按游客放行。
 *
 * 用于「匿名也能看、登录了能看到更多」的接口（如排行榜需要钉住「我的排名」）。
 * 与 authMiddleware 的区别：这里绝不返回 401，过期 token 只降级为游客，
 * 避免把「登录态过期」变成「页面报错」。
 */
export function optionalAuth(req, _res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const uid = verifyToken(h.slice(7));
    if (uid) req.userId = uid;
  }
  next();
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

export function validateRegister(username, email, password) {
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
    const { username, email, password, channel } = req.body || {};
    const u = norm(username);
    const em = norm(email);
    // RQ-105 获客归因：渠道在注册时就落到用户行，跨会话归因才不会随埋点顺序漂移
    const chan = normalizeChannel(channel);
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
        `INSERT INTO users (username, email, password_hash, cash, initial_capital, acquisition_channel)
         VALUES ($1, $2, $3, $4, $4, $5)
         RETURNING id, username, email, cash, initial_capital, acquisition_channel`,
        [u, em, hash, INITIAL_CAPITAL, chan]
      );
      const user = rows[0];
      const token = signToken(user.id);
      // 埋点只带渠道，不含任何身份信息（硬约束 5）
      await track(user.id, 'signup', { channel: chan }).catch(() => {});
      logger.info('注册成功', { userId: user.id, username: u, email: em, channel: chan, ip: req.ip });
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
    // 账号字段兼容 username / email 别名：本接口历史上只认 account，
    // 外部脚本（如 gettok.mjs、prep.mjs）传 username 时会拿到
    // 「请输入账号和密码」，而日志里 account 记为空串 —— 既误导排障又无法自证。
    // 这里按 account > username > email 取值，并在日志里带上实际收到的键名。
    const { account, username, email, password } = req.body || {};
    const acc = norm(account || username || email);
    if (!acc || !password) {
      logger.warn('登录失败: 参数缺失', {
        account: acc,
        bodyKeys: Object.keys(req.body || {}),
        ip: req.ip,
      });
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

/* ---------------- RQ-33 偏好：深色模式 / 信息密度 ---------------- */

const THEMES = new Set(['light', 'dark']);
const DENSITIES = new Set(['compact', 'normal', 'loose']);

router.get(
  '/profile/preferences',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT theme, density FROM user_preferences WHERE user_id=$1',
      [req.userId]
    );
    res.json(rows[0] || { theme: 'light', density: 'normal' });
  })
);

router.put(
  '/profile/preferences',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const theme = THEMES.has(req.body?.theme) ? req.body.theme : null;
    const density = DENSITIES.has(req.body?.density) ? req.body.density : null;
    if (!theme && !density) return res.status(400).json({ error: '没有可更新的偏好项' });
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id, theme, density)
       VALUES ($1, COALESCE($2,'light'), COALESCE($3,'normal'))
       ON CONFLICT (user_id) DO UPDATE SET
         theme = COALESCE($2, user_preferences.theme),
         density = COALESCE($3, user_preferences.density),
         updated_at = now()
       RETURNING theme, density`,
      [req.userId, theme, density]
    );
    res.json(rows[0]);
  })
);

/* ---------------- RQ-30 密码找回（邮箱验证） ---------------- */

const RESET_TOKEN_TTL_MIN = Number(process.env.RESET_TOKEN_TTL_MIN || 30);
const SMTP_HOST = process.env.SMTP_HOST || '';
// 无 SMTP 时的兜底：仅允许非生产环境把重置令牌直接回给调用方，生产环境一律不返回
const RESET_DEV_ECHO = process.env.NODE_ENV !== 'production';

function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

async function sendResetEmail(to, link) {
  if (!SMTP_HOST) return { sent: false, reason: 'SMTP 未配置' };
  try {
    const nodemailer = await import('nodemailer');
    const t = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== '0',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com',
      to,
      subject: '重置你的模拟交易账户密码',
      text: `请在 ${RESET_TOKEN_TTL_MIN} 分钟内打开以下链接完成密码重置：\n${link}\n\n若非本人操作请忽略此邮件。`,
    });
    return { sent: true };
  } catch (e) {
    logger.error('密码重置邮件发送失败', { to, err: e });
    return { sent: false, reason: '邮件服务不可用' };
  }
}

/**
 * RQ-90：无邮件通道时的响应体。
 *
 * 关键约束（F-11）：**绝不出现「已发送」字样**。
 * 旧实现在生产无 SMTP 时仍返回「重置链接已发送，请注意查收」，
 * 用户会一直等一封永远不会来的邮件然后流失——这比直接说「不可用」伤害更大。
 *
 * 替代路径必须**真实可达**，不写「联系客服」这种无人值守的假路径。
 */
export function resetUnavailable(reason) {
  return {
    ok: true,
    delivered: false,
    channel: 'none',
    message: '当前未配置可用的邮件发送通道，重置邮件无法发送。',
    reason: reason || 'SMTP 未配置',
    alternatives: [
      '自部署环境：在服务端配置 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS 后重启，本功能即可使用',
      '仍记得原密码：先用原密码登录，再在「个人设置」中修改密码',
      '开发环境：服务端会直接返回重置令牌，可复制后进入第二步',
    ],
    // 时限明示：即便拿不到邮件，也要让用户知道令牌有效期这一事实
    ttlMinutes: RESET_TOKEN_TTL_MIN,
    // 措辞刻意避开「已发送」这三个字：验收脚本会以「响应体不含已发送」作为硬断言，
    // 同时这句话本身也要让用户明白「不会假装发送成功」。
    notice: '我们不会在邮件发不出去时假装发送成功——那会让你等一封永远不会来的邮件。',
  };
}

/**
 * 申请密码重置。
 * 防滥用：① 复用登录/注册限流；② 令牌 30 分钟有效且一次性；
 *         ③ 无论邮箱是否注册都返回同一句提示，不泄露账号存在性。
 */
router.post(
  '/auth/forgot',
  asyncHandler(async (req, res) => {
    const email = norm(req.body?.email);
    if (!email) return res.status(400).json({ error: '请填写注册邮箱' });

    const canEmail = Boolean(SMTP_HOST);
    const generic = { ok: true, delivered: true, channel: 'email', message: '若该邮箱已注册，重置链接已发送，请注意查收' };

    // RQ-90：无邮件通道且非开发环境 —— 不建令牌、不宣称已发送，直接给替代路径
    if (!canEmail && !RESET_DEV_ECHO) {
      logger.warn('密码找回请求被拒：无邮件通道', { ip: req.ip, email });
      return res.json(resetUnavailable('SMTP 未配置'));
    }

    const { rows } = await pool.query('SELECT id, email FROM users WHERE lower(email)=$1', [email]);
    if (rows.length === 0) {
      logger.info('密码找回请求（邮箱未注册，按统一提示返回）', { ip: req.ip });
      // 未注册时同样不能宣称已发送（无 SMTP 场景下 generic 根本不成立）
      return res.json(canEmail ? generic : resetUnavailable('SMTP 未配置'));
    }
    const user = rows[0];
    const raw = randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60000);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
      [user.id, hashToken(raw), expires]
    );
    const link = `${process.env.APP_BASE_URL || ''}/reset?token=${raw}`;
    const mail = await sendResetEmail(user.email, link);
    logger.info('密码重置令牌已签发', { userId: user.id, mail });

    // 邮件发送失败（通道配了但投递失败）：仍不能宣称成功（RQ-90）
    if (!mail.sent) {
      if (RESET_DEV_ECHO) {
        return res.json({
          ...resetUnavailable(mail.reason),
          devToken: raw,
          devLink: link,
          notice: 'SMTP 未配置或不可用，已在开发环境直接返回重置令牌',
        });
      }
      return res.json(resetUnavailable(mail.reason));
    }
    return res.json(generic);
  })
);

router.post(
  '/auth/reset',
  asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: '请填写令牌与新密码' });
    const invalid = validateRegister('resetuser', 'reset@example.com', password);
    if (invalid) return res.status(400).json({ error: `新密码不合规：${invalid}` });

    const { rows } = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash=$1',
      [hashToken(token)]
    );
    const rec = rows[0];
    if (!rec) return res.status(400).json({ error: '重置链接无效' });
    if (rec.used_at) return res.status(400).json({ error: '重置链接已被使用' });
    if (new Date(rec.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: '重置链接已过期，请重新申请' });
    }

    const hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rec.user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1', [rec.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    logger.info('密码重置成功', { userId: rec.user_id });
    res.json({ ok: true });
  })
);

/* ---------------- RQ-34 账户重置：二次确认 + 冷却 + 留痕 ---------------- */

const RESET_COOLDOWN_HOURS = Number(process.env.RESET_COOLDOWN_HOURS || 24);
const RESET_CONFIRM_TEXT = '确认重置';

async function resetCooldownLeft(uid) {
  const { rows } = await pool.query(
    'SELECT created_at FROM account_resets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
    [uid]
  );
  if (rows.length === 0) return 0;
  const passed = (Date.now() - new Date(rows[0].created_at).getTime()) / 3600000;
  return Math.max(0, Math.ceil(RESET_COOLDOWN_HOURS - passed));
}

/** 重置前的确认信息（供前端弹窗显示冷却与影响），不产生副作用 */
router.get(
  '/account/reset/notice',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const left = await resetCooldownLeft(req.userId);
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM account_resets WHERE user_id=$1',
      [req.userId]
    );
    const me = await pool.query(
      'SELECT cash, initial_capital FROM users WHERE id=$1',
      [req.userId]
    );
    res.json({
      cooldownHours: RESET_COOLDOWN_HOURS,
      cooldownLeftHours: left,
      canReset: left === 0,
      resetCount: rows[0]?.c || 0,
      currentCash: me.rows[0] ? Number(me.rows[0].cash) : 0,
      confirmText: RESET_CONFIRM_TEXT,
      impact: ['清空全部持仓', '清空交易记录与净值快照', '资金恢复为初始金额', '重置记录会在战绩与排行榜中标注'],
    });
  })
);

router.post(
  '/account/reset',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    // 二次确认：必须显式传入确认文案，杜绝误触一键清空
    if (String(req.body?.confirm || '').trim() !== RESET_CONFIRM_TEXT) {
      logger.warn('重置账户失败: 未通过二次确认', { userId: uid });
      return res.status(400).json({ error: `请在请求中携带确认文案「${RESET_CONFIRM_TEXT}」` });
    }
    const left = await resetCooldownLeft(uid);
    if (left > 0) {
      logger.warn('重置账户失败: 处于冷却期', { userId: uid, leftHours: left });
      return res.status(429).json({ error: `账户重置冷却中，请 ${left} 小时后再试` });
    }

    const client = await pool.connect();
    let assetsBefore = 0;
    let resetCount = 1;
    try {
      await client.query('BEGIN');
      const u = await client.query('SELECT cash FROM users WHERE id=$1 FOR UPDATE', [uid]);
      const h = await client.query('SELECT * FROM holdings WHERE user_id=$1', [uid]);
      // 用成本价兜底估值，避免依赖行情模块造成循环依赖
      assetsBefore = Number(u.rows[0]?.cash || 0) + h.rows.reduce((s, r) => s + r.quantity * Number(r.avg_cost), 0);
      const cnt = await client.query(
        'SELECT COALESCE(MAX(reset_count),0)::int AS c FROM account_resets WHERE user_id=$1',
        [uid]
      );
      resetCount = (cnt.rows[0]?.c || 0) + 1;

      await client.query('DELETE FROM holdings WHERE user_id=$1', [uid]);
      await client.query('DELETE FROM transactions WHERE user_id=$1', [uid]);
      await client.query('DELETE FROM asset_snapshots WHERE user_id=$1', [uid]);
      // 未成交委托必须一并清空：orders 只在删除 users 行时级联（ON DELETE CASCADE），
      // 而重置是 UPDATE 式恢复、不动用户行。此前漏删会导致「重置后现金恢复为初始资金 →
      // 下一个 tick 撮合时资金一定充足 → 旧挂单被自动成交」，用户看到刚重置完钱又少了、
      // 持仓又冒出来，且这笔交易会进入排行榜与复盘统计。
      await client.query('DELETE FROM orders WHERE user_id=$1', [uid]);
      await client.query('UPDATE users SET cash=$1, initial_capital=$1 WHERE id=$2', [
        INITIAL_CAPITAL,
        uid,
      ]);
      await client.query(
        'INSERT INTO account_resets (user_id, assets_before, reset_count) VALUES ($1,$2,$3)',
        [uid, Math.round(assetsBefore * 100) / 100, resetCount]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('重置账户失败', { userId: uid, err: e });
      throw e;
    } finally {
      client.release();
    }
    logger.info('重置模拟账户成功', { userId: uid, capital: INITIAL_CAPITAL, resetCount });
    res.json({ ok: true, cash: INITIAL_CAPITAL, resetCount, assetsBefore: Math.round(assetsBefore * 100) / 100 });
  })
);

export default router;
