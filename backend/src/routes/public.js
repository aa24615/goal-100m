// 公网可达性自检与游客会话（RQ-121 规范端点 / RQ-122 公网入口 / RQ-108 免登录练一次）

import express from 'express';
import pool from '../db.js';
import { asyncHandler, businessError } from '../middleware.js';
import { optionalAuth } from '../auth.js';
import {
  resolvePublicAccess,
  renderNginxServerConf,
  renderEnvSnippet,
  suggestEphemeralDomain,
  isPublicIpv4,
  PUBLIC_ACCESS_ENV_KEYS,
} from '../services/publicAccessService.js';
import {
  identityOf,
  guestTokenFromRequest,
  newGuestToken,
  guestQuota,
  GUEST_DAILY_LIMIT,
  GUEST_TODAY_SQL,
} from '../services/guestService.js';
import { COMPLETION } from '../services/completionContract.js';

const router = express.Router();

/* ---------------------- RQ-121 / RQ-122 公网可达性 ---------------------- */

/**
 * 公网可达性状态。**无需登录**。
 *
 * 刻意不加鉴权：这是部署自检接口，要求鉴权会让「运维在部署机上 curl 一下看看」
 * 这件最基本的事做不了。RQ-122 要的就是「可断言」——能 curl 才能断言。
 *
 * 只回显对外地址与缺失项，不回显任何密钥。
 */
router.get('/public/access', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const ip = String(req.query?.ip || '').trim();
  const suggested = isPublicIpv4(ip) ? suggestEphemeralDomain(ip) : null;
  res.json({
    ...a,
    envKeys: PUBLIC_ACCESS_ENV_KEYS,
    // 没有自有域名时给一条今天就能走的路：免费泛解析域名（IP 编进域名）
    suggestion: suggested
      ? {
          domain: suggested,
          env: renderEnvSnippet({ host: suggested }),
          note: '无自有域名时的过渡方案；正式域名到位后替换 PUBLIC_BASE_URL 即可。',
        }
      : null,
    nextAction: a.ready ? '公网入口已就绪，进入 RQ-124 首训实测。' : (a.blockers[0] ?? '配置 PUBLIC_BASE_URL'),
  });
});

/** nginx 反代配置片段：给运维直接粘贴用，避免手抄出错 */
router.get('/public/access/nginx', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const host = a.host || (isPublicIpv4(String(req.query?.ip || '')) ? suggestEphemeralDomain(req.query.ip) : null);
  if (!host) throw businessError('尚未配置对外域名，无法生成 nginx 配置（可带 ?ip=公网IP 生成过渡方案）', 400);
  res.type('text/plain').send(renderNginxServerConf({ host }));
});

/** .env 片段：PUBLIC_BASE_URL 的唯一写入口径 */
router.get('/public/access/env', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const host = a.host || (isPublicIpv4(String(req.query?.ip || '')) ? suggestEphemeralDomain(req.query.ip) : null);
  if (!host) throw businessError('尚未配置对外域名，无法生成 .env 片段（可带 ?ip=公网IP 生成过渡方案）', 400);
  res.type('text/plain').send(renderEnvSnippet({ host }));
});

/* ---------------------- RQ-121 / RQ-108 游客会话 ---------------------- */

/** 游客今日已开始的局数 */
async function guestUsedToday(token) {
  if (!token) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM blind_sessions
      WHERE guest_token=$1 AND ${GUEST_TODAY_SQL}`,
    [token]
  );
  return rows[0]?.c || 0;
}

/**
 * 创建（或复用）游客会话。
 *
 * 硬约束 7：**不写 users 表**。写入会污染注册用户数，而北极星「首训完成率」
 * 的分母就是注册用户数——分母混进游客，指标立刻失真。
 */
router.post(
  '/guest/session',
  optionalAuth,
  asyncHandler(async (req, res) => {
    // 已登录用户不需要游客身份：直接回自己的身份，避免同一人分裂成两个口径
    if (req.userId) {
      res.json({
        kind: 'user',
        userId: req.userId,
        guestToken: null,
        quota: null,
        note: '已登录用户无需游客身份；游客 token 仅用于免登录试练。',
      });
      return;
    }
    const existing = guestTokenFromRequest(req);
    const token = existing || newGuestToken();
    const quota = guestQuota(await guestUsedToday(token));
    res.json({
      kind: 'guest',
      userId: null,
      guestToken: token,
      created: !existing,
      limit: GUEST_DAILY_LIMIT,
      quota,
      // RQ-109：完成口径随身份下发，避免前端另写一套
      completion: { definition: COMPLETION.definition, status: COMPLETION.sessionStatus },
      note: '游客局不写入 users 表；注册的唯一理由是保留成绩与连打。',
    });
  })
);

/**
 * 查询当前游客会话额度。
 *
 * 匿名访问**不返回 404**（RQ-121 的验收判据是「非 404」），而是明确告知如何取得身份——
 * 因为「身份缺失」和「接口不存在」对调用方是完全不同的两类问题。
 */
router.get(
  '/guest/session',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = identityOf({ userId: req.userId ?? null, guestToken: guestTokenFromRequest(req) });
    if (id.userId) {
      res.json({ hasSession: true, kind: 'user', userId: id.userId, guestToken: null, quota: null });
      return;
    }
    if (!id.guestToken) {
      res.json({
        hasSession: false,
        kind: 'anonymous',
        quota: guestQuota(0),
        howTo: 'POST /api/guest/session 获取游客 token，并在后续请求带上 X-Guest-Token 头。',
      });
      return;
    }
    const quota = guestQuota(await guestUsedToday(id.guestToken));
    res.json({
      hasSession: true,
      kind: 'guest',
      guestToken: id.guestToken,
      limit: GUEST_DAILY_LIMIT,
      quota,
    });
  })
);

export default router;
