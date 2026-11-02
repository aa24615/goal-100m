// 公网可达性自检与游客会话（RQ-121 规范端点 / RQ-122 公网入口 / RQ-108 免登录练一次）

import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { ownerState, frozenGate, FROZEN_RQS } from '../services/publicEntryService.js';
import {
  auditStageZero,
  buildLandingCopy,
  statusTruthfulness,
  auditDocsPublicness,
  renderVisitorHelp,
  rewriteDocForPublic,
  FROZEN_RQS_V15,
} from '../services/stageZeroService.js';

const router = express.Router();

/**
 * 读取仓库根的三个配置文件（.env / nginx.conf / README.md）。
 *
 * 容器里这些文件不存在（backend 镜像只有 /app），此时**静默降级**：
 * 用进程环境变量补齐 .env 的口径，绝不因为读不到文件就报一堆假 blocker ——
 * 假 blocker 会让运维在第一眼看到 5 个红叉之后放弃读这份报告（F-99 的行为模式）。
 */
function repoTexts() {
  const out = { envText: '', nginxText: '', readmeText: '', files: [] };
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const cands = [
      ['.env', 'envText'],
      [join('frontend', 'nginx.conf'), 'nginxText'],
      ['README.md', 'readmeText'],
    ];
    for (const [rel, key] of cands) {
      const p = join(root, rel);
      if (existsSync(p)) {
        out[key] = readFileSync(p, 'utf8');
        out.files.push(rel);
      }
    }
  } catch {
    /* 读不到就降级 */
  }
  if (!out.envText) {
    // 用进程环境补齐：容器里 .env 由 docker-compose 注入环境变量，语义等价
    out.envText = ['PUBLIC_BASE_URL', 'DOMAIN', 'PUBLIC_HOST', 'PUBLIC_ENTRY_OWNER', 'PUBLIC_ENTRY_DEADLINE']
      .filter((k) => process.env[k])
      .map((k) => `${k}=${process.env[k]}`)
      .join('\n');
  }
  return out;
}

function envMap(envText) {
  return Object.fromEntries(
    String(envText ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
}

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

  /**
   * RQ-160 责任人 + RQ-172 冻结护栏：与「能不能访问」一起返回。
   *
   * 分开成两个端点的结果是没人会去调第二个——而 owner 恰恰是最容易过期、
   * 且过期后无声无息的那一项。把三者放在同一份响应里，运维每次 curl 都会看到。
   */
  const texts = repoTexts();
  const env = envMap(texts.envText);
  const own = ownerState({
    owner: env.PUBLIC_ENTRY_OWNER || process.env.PUBLIC_ENTRY_OWNER,
    deadline: env.PUBLIC_ENTRY_DEADLINE || process.env.PUBLIC_ENTRY_DEADLINE,
  });
  const gate = frozenGate({ publicReady: a.ready, owner: own });

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
    owner: own,
    gate,
    provision: a.ready
      ? null
      : 'node src/scripts/provisionPublicEntry.js --domain=<域名> --owner=<责任人> --deadline=YYYY-MM-DD --apply',
    nextAction: a.ready
      ? own.blocked
        ? `公网已就绪，但责任人状态为 ${own.state}：${own.note}`
        : '公网入口已就绪，进入 RQ-159 外部真实用户验证。'
      : own.blocked
        ? `公网未就绪且无责任人：${own.note}（连续多版未完成的根因是没有 owner，不只是没配域名）`
        : (a.blockers[0] ?? '配置 PUBLIC_BASE_URL'),
  });
});

/**
 * RQ-172 冻结护栏：明确列出「RQ-156 完成前不许开工」的需求。
 *
 * 单独成端点的理由：这个列表是给**需求评审**用的，评审时需要一个能直接贴进
 * 会议记录的清单，而不是从公网自检的大响应里翻字段。
 */
router.get('/public/gate', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const texts = repoTexts();
  const env = envMap(texts.envText);
  const own = ownerState({
    owner: env.PUBLIC_ENTRY_OWNER || process.env.PUBLIC_ENTRY_OWNER,
    deadline: env.PUBLIC_ENTRY_DEADLINE || process.env.PUBLIC_ENTRY_DEADLINE,
  });
  const requested = String(req.query?.rq || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  res.json({
    ...frozenGate({ publicReady: a.ready, owner: own, requested: requested.length ? requested : undefined }),
    frozenList: FROZEN_RQS,
    rule: 'RQ-156 未完成前，RQ-161~170 一律不进排期（本条不再软化）。',
  });
});

/* ---------------------- v15 阶段零（RQ-173~177） ---------------------- */

/**
 * 阶段零总览：RQ-173~177 五项 P0 的可断言报告。**无需登录**。
 *
 * 刻意不加鉴权，理由与 `/public/access` 相同——这是部署自检接口，
 * 让运维/自动化在部署机上 curl 一下就能拿到「阶段零到底过了几项」，
 * 而不是去翻需求文档里上一版写的结论（那是连续六版误判的机制）。
 *
 * 支持 `?docs=1` 附带仓库三份文档（.env / nginx / README）的对外化审计结果，
 * 默认关闭：文档读取有 IO 成本，而自检高频调用时并不需要每次都扫。
 */
router.get('/public/stage-zero', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const texts = repoTexts();
  const env = envMap(texts.envText);
  const own = ownerState({
    owner: env.PUBLIC_ENTRY_OWNER || process.env.PUBLIC_ENTRY_OWNER,
    deadline: env.PUBLIC_ENTRY_DEADLINE || process.env.PUBLIC_ENTRY_DEADLINE,
  });

  const withDocs = String(req.query?.docs || '').trim() === '1';
  const docsInput = withDocs
    ? {
        publicUrl: a.publicUrl,
        docs: [
          { name: 'README.md', text: texts.readmeText },
          { name: 'frontend/nginx.conf', text: texts.nginxText },
        ].filter((d) => String(d.text || '').length > 0),
      }
    : { publicUrl: a.publicUrl, docs: [] };

  const report = auditStageZero({
    entry: { ready: a.ready, nextAction: a.nextAction, publicUrl: a.publicUrl },
    owner: own,
    readmeText: texts.readmeText,
    docsInput,
    // 首屏路径与游客能力由前端常量保证，后端此处给出的是**验收口径**而非实时探测
    landingInput: {
      elements: ['what', 'register', 'retention'],
      path: [{ id: 'enter', label: '进入训练', kind: 'click' }, { id: 'start', label: '开始一局', kind: 'click' }],
      guestTrainable: true,
    },
  });

  res.json({
    ...report,
    publicUrl: a.publicUrl,
    owner: own,
    frozenV13: FROZEN_RQS,
    hint: '?docs=1 可附带 README / nginx 的对外化审计',
  });
});

/**
 * RQ-173 状态口径自洽：入口事实 vs 文档口径。
 *
 * 单独成端点的理由：v15 实测抓到的 F-102 是「同一段里上面写未配置、下面写状态 ok」，
 * 这类矛盾必须能被**单独 curl 出来贴进会议记录**，埋在大响应里没人会看第二眼。
 */
router.get('/public/status-truth', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const texts = repoTexts();
  const env = envMap(texts.envText);
  const own = ownerState({
    owner: env.PUBLIC_ENTRY_OWNER || process.env.PUBLIC_ENTRY_OWNER,
    deadline: env.PUBLIC_ENTRY_DEADLINE || process.env.PUBLIC_ENTRY_DEADLINE,
  });
  res.json(statusTruthfulness({ entryReady: a.ready, owner: own, readmeText: texts.readmeText }));
});

/**
 * RQ-174 落地页三要素文案。**无需登录**。
 *
 * 文案由后端下发而不是前端写死：保留期与游客额度是会变的运营参数，
 * 前端复制一份常量必然与后端行为漂移——而漂移后的承诺比不承诺更有害。
 */
router.get('/public/landing', (req, res) => {
  res.json({
    ...buildLandingCopy({
      guestLimit: process.env.GUEST_DAILY_LIMIT || null,
      guestDays: process.env.GUEST_RETENTION_DAYS || null,
      userRetention: process.env.USER_RETENTION_TEXT || '',
      disclaimer: process.env.LANDING_DISCLAIMER || '',
    }),
    maxClicks: 2,
    guestEntry: '/guest/session',
  });
});

/**
 * RQ-175 面向外部访客的帮助（非部署者视角）。`?format=md` 返回 Markdown 原文。
 */
router.get('/public/help', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const md = renderVisitorHelp({
    publicUrl: a.publicUrl,
    guestLimit: process.env.GUEST_DAILY_LIMIT || null,
    guestDays: process.env.GUEST_RETENTION_DAYS || null,
  });
  if (String(req.query?.format || '').trim().toLowerCase() === 'md') {
    res.type('text/plain; charset=utf-8').send(md);
    return;
  }
  res.json({ publicUrl: a.publicUrl, markdown: md });
});

/**
 * RQ-175 文档对外化改写（dry-run）。
 * `?path=README.md` 返回把本机地址替换为对外地址后的全文，默认只回摘要。
 */
router.get('/public/docs/rewrite', (req, res) => {
  const a = resolvePublicAccess(process.env);
  const texts = repoTexts();
  const target = String(req.query?.path || '').trim();
  const pool = { 'README.md': texts.readmeText, 'frontend/nginx.conf': texts.nginxText };
  const name = pool[target] !== undefined ? target : null;
  if (!name) {
    res.json({
      ok: false,
      available: Object.keys(pool).filter((k) => String(pool[k] || '').length > 0),
      note: a.publicUrl ? '指定 ?path= 可查看改写后的全文。' : '尚未配置 PUBLIC_BASE_URL，无法改写（改写为空串比不改更糟）。',
    });
    return;
  }
  const scan = auditDocsPublicness([{ name, text: pool[name] }], { publicUrl: a.publicUrl });
  res.json({
    ok: true,
    name,
    publicUrl: a.publicUrl || null,
    ...scan.files[0],
    rewritten: a.publicUrl ? rewriteDocForPublic(pool[name], a.publicUrl) : null,
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
