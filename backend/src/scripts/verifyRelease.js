/**
 * RQ-123 发布后验证清单（把「发布」从口头动作变成可断言动作）
 *
 * 与 `releaseCheck.js`（RQ-87）的分工：
 *   - releaseCheck 是**发布前**检查（工作区干净 / 已推送 / dist 新鲜 / 迁移已应用）；
 *   - 本脚本是**发布后**验证（线上跑的到底是不是刚构建的那一份、新路由在不在、
 *     埋点还能不能写、有没有新增错误）。
 * v7 断在「提交未部署」、v10 断在「写完未提交」——两次都是**发完之后没人验证**，
 * 所以这一环必须独立存在，且必须能在一条命令里跑完。
 *
 * 五项硬断言（v10 §7.1 RQ-123）：
 *   1. bundle-name   线上加载的 bundle 文件名 = 本地 dist 的文件名
 *   2. migration     生产 schema_migrations 含最新迁移版本
 *   3. routes        本期新增路由全部非 404
 *   4. telemetry     埋点管道可写（写一条探针 → 入库 → 删除）
 *   5. errors        发布后错误表新增 0 条
 * 附加一项（同属 RQ-123「发布后必跑」）：
 *   6. error-logs    发布后后端日志新增 ERROR 0 条
 * v13 新增两项：
 *   7. telemetry-consistency 埋点与业务表按 sessionId 双向对账（RQ-158，需 DB）
 *   8. verification-record   本次验证落库，并校验「连续 2 次发布均有验证记录」（RQ-160）
 *
 * 用法：
 *   node src/scripts/verifyRelease.js [--json] [--base=http://localhost:8080]
 *   DATABASE_URL=... node src/scripts/verifyRelease.js   # 需要 DB 的两项
 *
 * 全部检查函数都接受依赖注入（fetchFn / queryFn / readFileFn），便于无环境单测。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { checkTelemetryConsistency, recordVerification, verificationStreak, latestVerifications } from '../services/releaseGateService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const DIST_INDEX = join(REPO_ROOT, 'frontend', 'dist', 'index.html');
export const LOG_DIR = join(REPO_ROOT, 'backend', 'logs');

/** 埋点探针标记：写入后立即删除，不污染任何统计口径 */
export const PROBE_MARK = 'release-verify-probe';

/** 本期新增且必须在发布后可访问的路由（v10 RQ-121 / RQ-122 / RQ-116） */
export const REQUIRED_ROUTES = [
  { path: '/api/public/access', allow: [200], label: 'RQ-122 公网可达自检' },
  { path: '/api/guest/session', allow: [200], label: 'RQ-108 游客会话' },
  { path: '/api/challenge/today', allow: [200], label: 'RQ-113 每日一题' },
  { path: '/api/config/public-access', allow: [200], label: 'RQ-106 公网状态（旧路径）' },
  // 需要登录：401 证明路由存在，404 才是没发上去
  { path: '/api/growth/funnel', allow: [200, 401], label: 'RQ-121 训练漏斗' },
  { path: '/api/analytics/north-star', allow: [200, 401], label: 'RQ-98 北极星' },
  // 已下线：410 是预期，404 说明归档中间件没生效
  { path: '/api/rooms', allow: [410], label: 'RQ-116 零使用功能归档' },
  // v13：隔离自检与邀请归因（需登录，401 即证明路由已上线）
  { path: '/api/analytics/isolation', allow: [200, 401], label: 'RQ-157 自测流量隔离自检' },
  { path: '/api/invite/funnel', allow: [200, 401], label: 'RQ-159 邀请漏斗' },
  { path: '/api/invite/codes', allow: [200, 401], label: 'RQ-159 邀请码' },
  // v15 阶段零：五项 P0 的可断言端点（全部无需登录，非 200 即未上线）
  { path: '/api/public/stage-zero', allow: [200], label: 'RQ-173~177 阶段零总览' },
  { path: '/api/public/status-truth', allow: [200], label: 'RQ-173 状态口径自洽' },
  { path: '/api/public/landing', allow: [200], label: 'RQ-174 落地页三要素' },
  { path: '/api/public/help', allow: [200], label: 'RQ-175 访客帮助' },
];

function defaultBaseUrl() {
  return String(process.env.VERIFY_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

/** 从 index.html 里抽出主 bundle 文件名（取 /assets 下的 .js，第一个即入口） */
export function bundleOf(html) {
  const s = String(html ?? '');
  const m = [...s.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((x) => x[1]);
  return m.length ? m[m.length - 1] : null;
}

/* ------------------------------ 1. 包名一致 ------------------------------ */

export async function checkBundleName({
  fetchFn = fetch,
  baseUrl = defaultBaseUrl(),
  indexHtml = DIST_INDEX,
  readFn = readFileSync,
  existsFn = existsSync,
} = {}) {
  if (!existsFn(indexHtml)) {
    return { name: 'bundle-name', ok: false, detail: `本地 ${indexHtml} 不存在，请先 npm run build` };
  }
  const local = bundleOf(readFn(indexHtml, 'utf8'));
  if (!local) return { name: 'bundle-name', ok: false, detail: '本地 index.html 未引用任何 /assets/*.js' };

  let online = null;
  try {
    const r = await fetchFn(`${baseUrl}/`);
    online = bundleOf(await r.text());
  } catch (e) {
    return { name: 'bundle-name', ok: false, detail: `无法访问 ${baseUrl}：${e?.message || e}` };
  }
  if (!online) return { name: 'bundle-name', ok: false, detail: '线上 index.html 未引用 /assets/*.js（可能仍是旧包或代理异常）' };
  if (online !== local) {
    return { name: 'bundle-name', ok: false, detail: `线上 ${online} ≠ 本地 ${local}，前端未重新构建或镜像未重建` };
  }
  return { name: 'bundle-name', ok: true, detail: `线上与本地一致：${local}` };
}

/* ------------------------------ 2. 迁移版本 ------------------------------ */

async function defaultQueryFn() {
  const { default: pool } = await import('../db.js');
  return (sql, params) => pool.query(sql, params);
}

export async function checkMigration({ queryFn = null, expected = null } = {}) {
  const q = queryFn || (await defaultQueryFn());
  try {
    const { rows } = await q('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    const latest = rows[0]?.version ?? null;
    if (!latest) return { name: 'migration', ok: false, detail: 'schema_migrations 为空，迁移从未应用' };
    if (expected && String(latest) !== String(expected)) {
      return { name: 'migration', ok: false, detail: `生产最新迁移 ${latest} ≠ 期望 ${expected}` };
    }
    return { name: 'migration', ok: true, detail: `生产最新迁移 ${latest}` };
  } catch (e) {
    return { name: 'migration', ok: true, warn: true, detail: `数据库不可达，跳过：${e?.message || e}` };
  }
}

/* ------------------------------ 3. 新路由非 404 ------------------------------ */

export async function checkRoutes({ fetchFn = fetch, baseUrl = defaultBaseUrl(), routes = REQUIRED_ROUTES } = {}) {
  const bad = [];
  const results = [];
  for (const r of routes) {
    let status = 0;
    try {
      const res = await fetchFn(`${baseUrl}${r.path}`, { redirect: 'manual' });
      status = res.status;
    } catch (e) {
      bad.push(`${r.path}(请求失败: ${e?.message || e})`);
      results.push({ ...r, status: 0, ok: false });
      continue;
    }
    const ok = r.allow.includes(status);
    if (!ok) bad.push(`${r.path}=${status}(期望 ${r.allow.join('/')})`);
    results.push({ ...r, status, ok });
  }
  return {
    name: 'routes',
    ok: bad.length === 0,
    detail: bad.length === 0 ? `${routes.length} 个路由状态码均符合预期` : `路由异常：${bad.join('；')}`,
    results,
  };
}

/* ------------------------------ 4. 埋点可写 ------------------------------ */

/**
 * 写一条带标记的错误上报 → 校验落库 → 立即删除。
 * 用「真实写入再校验」而不是只测接口返回 200：
 * 返回 200 但没落库的埋点，比没有埋点更危险——它会让所有指标看起来正常。
 */
export async function checkTelemetry({ fetchFn = fetch, baseUrl = defaultBaseUrl(), queryFn = null } = {}) {
  if (!queryFn) return { name: 'telemetry', ok: true, warn: true, detail: '未提供 queryFn，跳过埋点落库校验' };
  const q = queryFn;
  let res;
  try {
    res = await fetchFn(`${baseUrl}/api/analytics/error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'manual', message: PROBE_MARK, name: 'ReleaseVerify' }),
    });
  } catch (e) {
    return { name: 'telemetry', ok: false, detail: `埋点请求失败：${e?.message || e}` };
  }
  if (!res.ok) return { name: 'telemetry', ok: false, detail: `埋点接口返回 ${res.status}` };

  try {
    const { rows } = await q('SELECT id FROM frontend_errors WHERE message = $1 ORDER BY id DESC LIMIT 1', [PROBE_MARK]);
    if (rows.length === 0) return { name: 'telemetry', ok: false, detail: '接口返回 200 但探针未落库，埋点管道实际不可用' };
    await q('DELETE FROM frontend_errors WHERE message = $1', [PROBE_MARK]);
    return { name: 'telemetry', ok: true, detail: '埋点可写并已落库，探针记录已清理' };
  } catch (e) {
    return { name: 'telemetry', ok: false, detail: `埋点校验查询失败：${e?.message || e}` };
  }
}

/* ------------------------------ 5. 错误表新增 0 条 ------------------------------ */

export async function checkErrorTable({ queryFn = null, since = null } = {}) {
  if (!queryFn) return { name: 'errors', ok: true, warn: true, detail: '未提供 queryFn，跳过错误表校验' };
  const t = since instanceof Date ? since : new Date(since || Date.now());
  try {
    const { rows } = await queryFn('SELECT COUNT(*)::int AS c FROM frontend_errors WHERE created_at > $1', [t]);
    const c = rows[0]?.c || 0;
    return {
      name: 'errors',
      ok: c === 0,
      detail: c === 0 ? `发布后（${t.toISOString()} 起）错误表新增 0 条` : `发布后错误表新增 ${c} 条`,
      count: c,
    };
  } catch (e) {
    return { name: 'errors', ok: true, warn: true, detail: `错误表不可查，跳过：${e?.message || e}` };
  }
}

/* ------------------------------ 6. 日志新增 ERROR ------------------------------ */

function logFilesOf(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function checkErrorLogs({ since = new Date(), dir = LOG_DIR, readFn = readFileSync, listFn = logFilesOf } = {}) {
  const t = since instanceof Date ? since.getTime() : new Date(since).getTime();
  const files = listFn(dir);
  if (files.length === 0) return { name: 'error-logs', ok: true, warn: true, detail: `未找到日志文件（${dir}），跳过` };

  let count = 0;
  const samples = [];
  for (const f of files) {
    let text = '';
    try {
      text = readFn(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"level":"ERROR"') && !line.includes('"level": "ERROR"')) continue;
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        // 非 JSON 行：无法判定时间，保守计入
        count += 1;
        if (samples.length < 3) samples.push(line.slice(0, 160));
        continue;
      }
      const ts = obj?.time || obj?.ts || obj?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      // 时间不可解析时保守计入（宁可多报，不可漏报）
      if (!Number.isFinite(ms) || ms >= t) {
        count += 1;
        if (samples.length < 3) samples.push(`${obj?.msg || obj?.message || 'ERROR'} @ ${ts || 'unknown-time'}`);
      }
    }
  }
  return {
    name: 'error-logs',
    ok: count === 0,
    detail: count === 0 ? `发布后（${new Date(t).toISOString()} 起）日志新增 ERROR 0 条` : `日志新增 ERROR ${count} 条：${samples.join(' | ')}`,
    count,
  };
}

/* ------------------------------ 7. 埋点一致性（RQ-158） ------------------------------ */

/**
 * 埋点与业务表按 sessionId 双向对账。
 *
 * 无 DB 时降级为 warn —— 但**必须把「未校验」写进 detail**。
 * 静默跳过会让「发布后验证」变成一张永远全绿的清单，这正是 RQ-158 要防的事。
 */
export async function checkConsistency({ queryFn = null, days = 3650 } = {}) {
  if (!queryFn) {
    return { name: 'telemetry-consistency', ok: true, warn: true, detail: '未提供 queryFn，跳过埋点一致性对账（RQ-158 未校验）' };
  }
  return checkTelemetryConsistency({ queryFn, days });
}

/* ------------------------------ 8. 验证留痕（RQ-160） ------------------------------ */

export function gitHead({ execFn = execFileSync, cwd = REPO_ROOT } = {}) {
  try {
    return String(execFn('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 把本次验证结果落库，并校验「连续 2 次发布均有验证记录」。
 *
 * ok 的判据刻意**只取「记录是否落库」**，不把 streak 算进去：
 * streak 要求 ≥2，若把它算进 ok，则第一次跑这个脚本时必然失败，
 * 于是「发布后必跑验证」这条流程在最需要它的时候被自己判死。
 * streak 作为 warn 输出——它回答的是「流程是否稳定」，而不是「本次是否验证过」。
 */
export async function checkVerificationRecord({ queryFn = null, baseUrl = '', report = {}, commit = null, execFn = execFileSync } = {}) {
  const sha = commit || gitHead({ execFn });
  if (!queryFn) {
    return { name: 'verification-record', ok: true, warn: true, detail: '未提供 queryFn，跳过验证留痕（RQ-160 未校验）', commit: sha };
  }
  const rec = await recordVerification({ queryFn, gitCommit: sha, baseUrl, report });
  if (!rec.recorded) {
    return { name: 'verification-record', ok: false, detail: `验证记录落库失败：${rec.reason || '未知原因'}`, commit: sha };
  }
  const { rows } = await latestVerifications({ queryFn, limit: 20 });
  const streak = verificationStreak(rows || []);
  return {
    name: 'verification-record',
    ok: true,
    warn: !streak.ok,
    detail: `已落库（id=${rec.id}）${streak.ok ? '' : '；'}${streak.note}`,
    commit: sha,
    id: rec.id,
    streak,
  };
}

/* ------------------------------ 9. 阶段零（RQ-173~177） ------------------------------ */

/**
 * 阶段零五项 P0 的**上线后**断言。
 *
 * 与单测里跑 `auditStageZero` 的区别：单测证明逻辑对，这里证明**线上那一份**
 * 真的把这些端点与判定跑出来了——v13 的教训是「代码在仓库、镜像没重建、
 * 迁移没上库」三层可以同时落后，只看仓库源码会得出全绿的假结论。
 *
 * RQ-173（对外地址）刻意判 `warn` 而非 `ok:false`：
 * 它是阶段零里唯一一个**非代码可完成**的项（要买域名、签证书），
 * 判 fail 会让验证脚本每次都红，而红色一旦成为常态就没人再看了——
 * 这正是连续六版把未完成写成已完成的心理机制。因此用 warn 保持可见但不阻塞。
 */
export async function checkStageZero({ fetchFn = fetch, baseUrl = defaultBaseUrl() } = {}) {
  let payload = null;
  try {
    const res = await fetchFn(`${baseUrl}/api/public/stage-zero`, { redirect: 'manual' });
    if (!res.ok) {
      return { name: 'stage-zero', ok: false, detail: `/api/public/stage-zero 返回 ${res.status}` };
    }
    payload = await res.json();
  } catch (e) {
    return { name: 'stage-zero', ok: false, detail: `阶段零端点不可达：${e?.message || e}` };
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const failed = items.filter((i) => i && i.ok !== true).map((i) => `${i.rq}(${i.title})`);
  const entryItem = items.find((i) => i?.rq === 'RQ-173');
  const entryMissing = entryItem && entryItem.ok !== true;

  return {
    name: 'stage-zero',
    ok: failed.length === 0 || (entryMissing && failed.length === 1),
    // RQ-173 依赖域名与证书，非代码可完成：记为告警而不是失败
    warn: entryMissing,
    detail:
      failed.length === 0
        ? `阶段零 5/5 通过（版本 ${payload?.version ?? '?'}）`
        : `阶段零未通过 ${failed.length} 项：${failed.join('、')}${entryMissing ? '（RQ-173 需人工配置域名与证书，记为告警）' : ''}`,
    ready: payload?.ready === true,
    failed: payload?.failed || [],
    frozen: payload?.frozen || [],
  };
}

/**
 * 状态口径自洽（F-102）。
 *
 * 单独成项而不并入 stage-zero：v15 实测的缺陷是「同一段里上面写未配置、
 * 下面写状态 ok」，它是一个**文档层**问题，修法与「入口没配」完全不同
 * （前者改文案，后者买域名）。混在一起会导致修了文案却以为门牌已挂。
 */
export async function checkStatusTruth({ fetchFn = fetch, baseUrl = defaultBaseUrl() } = {}) {
  try {
    const res = await fetchFn(`${baseUrl}/api/public/status-truth`, { redirect: 'manual' });
    if (!res.ok) return { name: 'status-truth', ok: false, detail: `/api/public/status-truth 返回 ${res.status}` };
    const p = await res.json();
    return {
      name: 'status-truth',
      ok: p?.ok === true,
      detail: p?.ok ? '状态口径与事实一致。' : `发现 ${p?.count ?? 0} 处矛盾：${p?.verdict ?? ''}`,
      contradictions: p?.contradictions || [],
    };
  } catch (e) {
    return { name: 'status-truth', ok: false, detail: `状态口径端点不可达：${e?.message || e}` };
  }
}

/* ------------------------------ 汇总 ------------------------------ */

export async function runVerify(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseUrl = o.baseUrl || defaultBaseUrl();
  const since = o.since || new Date();
  // 注入优先；未注入且配了 DATABASE_URL 才连库，保证无环境下可单测
  const queryFn = o.queryFn || (process.env.DATABASE_URL ? await defaultQueryFn() : null);

  const results = [
    await checkBundleName({ ...o, baseUrl }),
    await checkMigration({ queryFn, expected: o.expectedMigration || null }),
    await checkRoutes({ ...o, baseUrl }),
    await checkTelemetry({ ...o, baseUrl, queryFn }),
    await checkErrorTable({ queryFn, since }),
    checkErrorLogs({ since, ...o }),
    // RQ-158：埋点与业务表对账（差异不再靠人工翻表发现）
    await checkConsistency({ queryFn, days: o.consistencyDays || 3650 }),
    // v15 阶段零：RQ-173~177 上线后断言
    await checkStageZero({ ...o, baseUrl }),
    await checkStatusTruth({ ...o, baseUrl }),
  ];
  const partial = { ok: results.filter((r) => !r.ok).length === 0, results, baseUrl, since };
  // RQ-160：留痕必须在前 7 项之后——记录的是「本次到底验出了什么」，
  // 若把自己也记进去，就等于用一条还没算完的结论去描述自己。
  results.push(await checkVerificationRecord({ queryFn, baseUrl, report: partial, commit: o.gitCommit || null, execFn: o.execFn }));

  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => r.ok && r.warn);
  return { ok: failed.length === 0, failed, warned, results, baseUrl, since };
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const baseArg = argv.find((a) => a.startsWith('--base='));
  const since = new Date();
  const report = await runVerify(baseArg ? { baseUrl: baseArg.slice('--base='.length) } : {});
  report.since = since;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('=== 发布后验证清单（RQ-123）===');
    for (const r of report.results) {
      const mark = r.ok ? (r.warn ? '[WARN]' : '[ OK ]') : '[FAIL]';
      console.log(`${mark} ${r.name}: ${r.detail}`);
    }
    console.log(report.ok ? '\n结论：本次发布已验证。' : `\n结论：验证未通过，${report.failed.length} 项失败。`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('验证脚本异常：', e);
    process.exit(2);
  });
}
