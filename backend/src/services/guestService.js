/**
 * 游客训练归属（RQ-108 / I-9 / F-36）
 *
 * 竞品（大波浪）已验证的形态：**网页版打开即用，不用登录就能练**；
 * 微信扫码登录后才保存记录与段位。我们当前的注册是「第一次训练」的前置门槛——
 * 用户在体验到任何价值之前就被要求注册（F-36）。
 *
 * 设计取舍：
 *   1. **不给游客伪造 users 行**。伪造会污染注册用户数，而 v9 的北极星
 *      「首训完成率」分母就是注册用户数——分母一旦混入游客，指标立刻失真。
 *      游客会话用 guest_token 归属，user_id 留空（迁移 0019 已放开 NOT NULL）。
 *   2. **游客只能玩一次短局**。极小额度的免费额度是竞品验证过的形态，
 *      且能避免匿名写入被刷。注册的唯一理由写成一句话：「保留这次成绩、记录连打」。
 *   3. **token 由客户端提供并校验格式**，服务端不做设备指纹、不采集身份信息（硬约束 4）。
 */

import { randomBytes } from 'node:crypto';

export const GUEST_TOKEN_MIN = 8;
export const GUEST_TOKEN_MAX = 64;
/** 游客每自然日可用的免费局数（超出后引导注册，不静默失败） */
export const GUEST_DAILY_LIMIT = 3;

/**
 * 「今日」的 SQL 判定片段（Asia/Shanghai 自然日）。
 *
 * 原先写成 `created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date`：
 * 左侧 created_at 是 timestamptz，右侧转成 date 后再隐式比 timestamptz，
 * 会按 UTC 午夜对齐——于是北京时间 08:00（UTC 00:00 前）创建的会话**不计入今日**，
 * 游客额度永远用不完，等于没有额度。
 *
 * 正确做法：两侧都先换算到上海时区再取日期，日界与用户感知一致。
 */
export const GUEST_TODAY_SQL =
  "(created_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date";

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export function newGuestToken(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

/** 校验并归一化游客 token；不合法返回 null（调用方按「无游客身份」处理） */
export function normalizeGuestToken(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.length < GUEST_TOKEN_MIN || s.length > GUEST_TOKEN_MAX) return null;
  if (!TOKEN_RE.test(s)) return null;
  return s;
}

/** 从请求里提取游客 token：优先自定义头，其次 body / query */
export function guestTokenFromRequest(req) {
  const h = req?.headers?.['x-guest-token'];
  const fromHeader = normalizeGuestToken(h);
  if (fromHeader) return fromHeader;
  const fromBody = normalizeGuestToken(req?.body?.guestToken);
  if (fromBody) return fromBody;
  return normalizeGuestToken(req?.query?.guestToken) || null;
}

/**
 * 用户 ID 归一化：**缺失必须归一为 null，绝不能变成 0**。
 *
 * `Number(null) === 0`，而 `Number.isFinite(0) === true`——
 * 沿用 `Number.isFinite(Number(v))` 的写法，游客（userId 为 null）会被算成 **userId = 0**，
 * 写库时撞上 `blind_sessions_user_id_fkey` 外键约束报 23503，
 * 表现为「游客一开局就 500」。
 *
 * 这个缺陷在 v9 完全没暴露：RQ-108 只有单测、没有集成测试，
 * 而单测覆盖的是纯函数，永远走不到外键那一步。
 */
export function safeUserId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 归属身份：登录用户优先于游客。
 * 同时登录且带游客 token 时以用户为准——避免登录后看不到自己游客局的成绩。
 */
export function identityOf(o) {
  const src = o && typeof o === 'object' ? o : {};
  const userId = safeUserId(src.userId);
  const guestToken = userId ? null : normalizeGuestToken(src.guestToken);
  return {
    userId,
    guestToken,
    isGuest: !userId && Boolean(guestToken),
    anonymous: !userId && !guestToken,
  };
}

/**
 * 生成 SQL 归属条件与参数。
 *
 * 注意：**绝不拼接 token 原文到 SQL**，一律走 $n 占位符。
 *
 * @returns {{clause:string, params:Array, index:number}|null} 无身份时返回 null
 */
export function ownerClause(identity, startIndex = 1) {
  const id = identityOf(identity);
  if (id.userId) return { clause: 'user_id=$1', params: [id.userId], index: startIndex + 1 };
  if (id.guestToken) return { clause: 'guest_token=$1', params: [id.guestToken], index: startIndex + 1 };
  return null;
}

/** 写入用的归属列与值 */
export function ownerInsert(identity) {
  const id = identityOf(identity);
  return { columns: ['user_id', 'guest_token'], values: [id.userId, id.guestToken] };
}

/**
 * 游客额度判定（纯函数）。
 * @param {number} usedToday 该 token 今日已开始的局数
 */
export function guestQuota(usedToday = 0) {
  const used = Math.max(0, Number(usedToday) || 0);
  const remaining = Math.max(0, GUEST_DAILY_LIMIT - used);
  return {
    allowed: remaining > 0,
    used,
    remaining,
    limit: GUEST_DAILY_LIMIT,
    // RQ-108 验收：成绩卡上有且只有一个注册理由
    signupReason: '注册后保留这次成绩、记录连打与每日一题进度。',
    message: remaining > 0
      ? `今日还可免登录练 ${remaining} 局。`
      : '今日免登录额度已用完，注册后不限次数并保留成绩。',
  };
}
