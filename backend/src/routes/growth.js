// 增长与可达性路由（RQ-106 公网入口 / RQ-107 局长度档位 / RQ-114 归因 / RQ-116 归档）

import express from 'express';
import { asyncHandler, businessError } from '../middleware.js';
import { optionalAuth, authMiddleware } from '../auth.js';
import { trainingFunnel } from '../services/trainingFunnelService.js';
import { mobileReadiness, DEVICES } from '../services/deviceService.js';
import {
  resolvePublicAccess,
  renderNginxServerConf,
} from '../services/publicAccessService.js';
import { BAR_PRESETS, resolveSessionLength, isShortByDefault, DEFAULT_BARS } from '../services/sessionLengthService.js';
import {
  buildShareLink,
  channelFromQuery,
  persistChannel,
  coverageOf,
  CHANNEL_PARAM,
  ACQUISITION_CHANNELS,
} from '../services/attributionService.js';
import { DECOMMISSIONED, archivedPayload } from '../services/decommissionService.js';

const router = express.Router();

/* ---------------------- RQ-106 公网可达性 ---------------------- */

/**
 * 公网可达性状态。**无需登录**：这是部署自检接口，
 * 要求鉴权会让「运维在部署机上 curl 一下看看」这件最基本的事做不了。
 */
router.get('/config/public-access', (req, res) => {
  const a = resolvePublicAccess(process.env);
  res.json({
    ...a,
    // 不回显任何密钥；只回显对外地址与缺失项
    envKeys: ['PUBLIC_BASE_URL', 'DOMAIN'],
  });
});

/** nginx 反代配置片段：给运维直接粘贴用，避免手抄出错 */
router.get('/config/nginx-conf', (_req, res) => {
  const a = resolvePublicAccess(process.env);
  if (!a.host) {
    throw businessError('尚未配置对外域名，无法生成 nginx 配置', 400);
  }
  res.type('text/plain').send(renderNginxServerConf({ host: a.host }));
});

/* ---------------------- RQ-107 局长度档位 ---------------------- */

/**
 * 局长度档位：页面一律从这里取，不硬编码 60。
 * 短局化的验收（默认 ≤15 根）由 isShortByDefault() 自证。
 */
router.get('/blind/presets', (_req, res) => {
  res.json({
    presets: BAR_PRESETS,
    defaultBars: DEFAULT_BARS,
    shortByDefault: isShortByDefault(),
    note: '默认走快局（12 根 / 1–2 次判断）；长局保留为进阶选项，不再是默认。',
  });
});

/** 解析任意入参到档位：前端传 key 或数字都可以，非法入参回落默认而不是 400 */
router.get('/blind/presets/resolve', (req, res) => {
  res.json(resolveSessionLength(req.query.preset ?? req.query.bars ?? null));
});

/* ---------------------- RQ-114 获客归因 ---------------------- */

/** 渠道字典 + 当前覆盖率要求 */
router.get('/attribution/channels', (_req, res) => {
  res.json({
    channels: ACQUISITION_CHANNELS,
    param: CHANNEL_PARAM,
    targetCoveragePct: 90,
    note: '未登记的渠道一律归入 unknown；脏渠道比没有渠道更糟，因为它看起来像数据。',
  });
});

/** 生成带渠道的分享链接。无公网地址时明确拒绝，不返回 localhost 链接。 */
router.post('/attribution/link', optionalAuth, (req, res) => {
  const a = resolvePublicAccess(process.env);
  const r = buildShareLink({
    baseUrl: a.publicUrl,
    channel: req.body?.channel ?? req.query?.channel,
    path: req.body?.path || '/training',
  });
  if (!r.ok) throw businessError(r.reason, 409);
  res.json({ ...r, publicReady: a.ready });
});

/** 把渠道落到当前用户行（登录后调用；幂等，不覆盖首次归因） */
router.post(
  '/attribution/attach',
  optionalAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) throw businessError('未登录，无法归因到用户', 401);
    const channel = channelFromQuery({ ...req.query, ...req.body });
    const r = await persistChannel(req.userId, channel);
    res.json({ ok: true, ...r });
  })
);

/** 归因覆盖率（RQ-114 验收：非空比例 ≥90%） */
router.get('/attribution/coverage', (req, res) => {
  // 纯展示口径：由调用方传入样本或读取 /analytics/acquisition 的结果
  const rows = Array.isArray(req.query.rows) ? req.query.rows : [];
  res.json(coverageOf(rows));
});

/* ---------------------- RQ-116 零使用功能下线 ---------------------- */

/**
 * RQ-121 规范端点：训练漏斗。
 * 与 `/analytics/funnel` 同一份数据、同一个 service，只是把路径固定成 v10 验收判据里写的那一个。
 * 不另算一套口径——两处数字打架比没有数字更糟。
 */
router.get(
  '/growth/funnel',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await trainingFunnel({ days: Number(req.query.days) || 30 }));
  })
);

/* ---------------------- RQ-127 移动端实测 ---------------------- */

/**
 * 移动端就绪自检（RQ-127 / F-38）。
 *
 * 真机走查替代不了，但**替代不了不等于可以没有任何判据**。
 * 这里把「手机能不能用」拆成可断言的项（触控目标尺寸、字号、视口、是否横向滚动），
 * 让真机走查有清单可依，而不是凭印象说「好像还行」。
 */
router.get('/config/mobile-checklist', (req, res) => {
  // 默认值即「未实测」：真机走查未完成前不应显示就绪（v8 的教训是把「已上线」当成「可用」）
  res.json({
    devices: DEVICES,
    readiness: mobileReadiness(),
    manual: [
      '竖屏从首页进入训练，不做任何缩放即可点「开始」。',
      '推进到决策点，记录一次决策并完成一局。',
      '成绩卡完整可见（误差带与禁止用途不溢出屏幕）。',
      '复制成绩卡文本并粘贴到任意聊天窗口，格式不乱。',
    ],
    note: '埋点已带设备维度；真机走查结果填入 manual 各项，作为 RQ-127 的验收留痕。',
  });
});

/** 归档清单：页面据此渲染「已归档」提示并提供替代入口 */
router.get('/config/archived', (_req, res) => {
  res.json({
    items: DECOMMISSIONED.map((d) => ({ ...d, payload: archivedPayload(d.path) })),
    note: '归档而非故障：路由返回 410 Gone 并给出替代路径，不再产生新数据。',
  });
});

export default router;
