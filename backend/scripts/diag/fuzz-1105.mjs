#!/usr/bin/env node
// 第十四轮探测（2026-11-05）：在 backend 容器内运行，直击 localhost:3001。
// 目标：用「结构化 query + 真实 JSON 类型 body」主动挖潜伏 5xx（方法论 #22：日志干净 ≠ 无缺陷）。
// 入口点：先 docker cp 本文件到容器 /tmp，再：
//   docker exec mm8888-backend-1 node -e "const jwt=require('/app/node_modules/jsonwebtoken');console.log(jwt.sign({sub:3},process.env.JWT_SECRET,{expiresIn:'2h'}))"
//   docker exec -e TOKEN=<上面> mm8888-backend-1 node /tmp/fuzz-1105.mjs
//
// 设计（沿用前 13 轮经验）：
//   - 不 import 路由模块（避免副作用），仅正则抽取 METHOD + path。
//   - 路径 :param 用样本 id（不存在 → 404 短路，不会打到 SQL；本脚本只为挖 query/body 类 5xx）。
//   - 排除不可逆 / 创建型端点（DANGER），返回 200 不等于没副作用（第 19 条）。
//   - 发现 5xx 立即打印响应体取证（第 18 条：日志按大小轮转只留 5 份，必须当场取证）。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:3001';
const TOKEN = process.env.TOKEN || '';
const ROUTES_DIR = '/app/src/routes';

// ----- 1. 抽取路由 -----
function extractRoutes() {
  const out = [];
  let files = [];
  try {
    files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
  } catch (e) {
    console.log('路由目录不可读:', e.message);
    return out;
  }
  for (const f of files) {
    const text = readFileSync(join(ROUTES_DIR, f), 'utf8');
    const re = /(?:router|app)\.(get|post|put|delete)\(\s*['"`](\/[^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(text))) {
      out.push({ method: m[1].toUpperCase(), path: m[2] });
    }
  }
  return out;
}

// ----- 2. 探测向量 -----
const BOUNDARY = [
  '-1', '0', '1', '1.5', '1e20', '1e309', '2147483648', '2147483647', '9007199254740993',
  'Infinity', '-Infinity', 'NaN', 'abc', 'true', 'false', 'null', '1e400', '0000-00-00',
  '2026-13-45', 'A'.repeat(50), '\u0000', '[]', '{}', '[1,2]',
  '1.7976931348623157e+308', '-1.7976931348623157e+308',
];
// 把所有数值/区间类字段合并成一条 query，避免「每字段 × 每值 × 每路由」爆炸
const COMBINED_KEYS = ['days', 'limit', 'page', 'pageSize', 'window', 'top', 'batch', 'start', 'end', 'from', 'to', 'gran', 'offset', 'count', 'isTest', 'rq', 'scope', 'event', 'code', 'ip', 'goalRegistered', 'goalEffective', 'apply', 'cursor', 'size'];
function combinedQuery(v) {
  return COMBINED_KEYS.map((k) => `${k}=${encodeURIComponent(v)}`).join('&');
}
// 结构化 query：让 req.query.x 变成数组 / 对象 / 重复键（Express qs）
const STRUCT = [
  'days=1&days=1e309', 'days[]=1&days[]=1e309', 'days[x]=1', 'days[a][b]=1',
  'limit=1&limit=1e20', 'limit[]=1&limit[]=abc', 'limit[x]=1',
  'start=Infinity&end=Infinity', 'from=2026-13-45&to=2026-13-45',
  'isTest=abc&isTest=TRUE', 'gran=abc&gran[]=x', 'rq=a&rq=b',
  'batch=1.5&top=1.5', 'window=1.5&days=1.5', 'days=-1&limit=-1',
  'days=2147483648&limit=2147483648', 'days=1.5&limit=1.5',
  'apply=1&apply=0', 'goalRegistered=1e309&goalEffective=1e309',
  'ip=a&ip=b', 'event=a&event=b', 'scope=a&scope=b', 'code=a&code=b',
  'page=1e309&pageSize=1e309', 'offset=-5&count=-5',
];

// 真实 JSON 类型 body（与「字符串标量」本质不同，第 11 条）
const BODY_TYPES = [
  null, true, false, 0, -1, 1.5, 10 ** 400, -(10 ** 400),
  [], [1, 2], ['a'], {}, { a: 1 }, { $gt: '' }, [{ a: 1 }], [null],
  '', ' ', 'abc', '1e309', 'Infinity', 'A'.repeat(5000), '\u0000',
  '2026-13-45', '0000-00-00',
];

// 安全 POST 基线（字段名真实，避免必填短路造成假阴性；第 14 条）
const SAFE_POST = [
  ['/api/analytics/track', { event: 'probe' }, ['event', 'payload', 'value', 'count']],
  ['/api/analytics/error', { message: 'probe', kind: 'error' }, ['message', 'code', 'stack', 'level', 'url', 'userAgent', 'appVersion', 'kind', 'name']],
  ['/api/review/_pair-check', { days: 30 }, ['days', 'limit']],
  ['/api/public/access/env', {}, ['days', 'env']],
  ['/api/public/docs/rewrite', { path: 'README.md' }, ['path']],
  ['/api/analytics/isolation', {}, ['days', 'window']],
  ['/api/analytics/isolation/backfill', {}, ['days']],
];

// 不可逆 / 创建型端点：跳过（第 19 条）
const DANGER = [
  'reset', 'finish', 'abandon', '/apply', 'purge', 'delete',
  '/api/orders', '/api/watchlist', '/api/blind/start', '/api/blind/prescription/start',
  '/api/replay/start', '/api/challenge/join', '/api/trade', '/api/market/next-day',
  '/api/account', '/api/guest/session', '/api/invite/codes', '/api/invite/bind',
  '/api/analytics/isolation/backfill',
];
function dangerous(p) {
  const lp = p.toLowerCase();
  return DANGER.some((d) => lp.includes(d));
}

// 路径样本 id（不存在 → 404 短路，安全；本脚本挖 query/body 类）
function fillPath(p) {
  return p.replace(/:id/g, '1').replace(/:code/g, '600519').replace(/:\w+/g, '1');
}

async function call(method, path, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  try {
    const r = await fetch(BASE + path, opts);
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 400) };
  } catch (e) {
    return { status: 'EXC:' + e.name, body: e.message.slice(0, 200) };
  }
}

async function main() {
  const routes = extractRoutes();
  console.log(`### 抽取到 ${routes.length} 条路由（来自 ${ROUTES_DIR}）`, { flush: true });

  const findings = [];
  let n = 0;
  const t0 = Date.now();

  function record(tag, method, full, status, body) {
    findings.push({ tag, method, full, status });
    console.log(`  >>> [5xx] ${tag} ${method} ${full} -> ${status} :: ${body.slice(0, 240)}`, { flush: true });
  }

  // 通道自证：先打一个确定存在的端点（/api/health 无需登录）
  const probe = await call('GET', '/api/health');
  console.log(`### 通道自证 /api/health -> ${probe.status}`, { flush: true });
  if (probe.status !== 200) {
    console.log('!!! 通道异常，结果不可信', { flush: true });
  }

  const getRoutes = routes.filter((r) => r.method === 'GET');
  const postRoutes = routes.filter((r) => r.method === 'POST' && !dangerous(r.path));

  // 阶段 1：GET 基线（路径样本 id）
  for (const r of getRoutes) {
    if (dangerous(r.path)) continue;
    const full = fillPath(r.path);
    const res = await call('GET', full, { token: TOKEN });
    n++;
    if (typeof res.status === 'number' && res.status >= 500) record('GET-BASE', 'GET', full, res.status, res.body);
  }

  // 阶段 2：GET + 边界 query（合并所有字段为一条 query，逐个边界值）
  for (const r of getRoutes) {
    if (dangerous(r.path)) continue;
    const base = fillPath(r.path);
    for (const v of BOUNDARY) {
      const full = base + (base.includes('?') ? '&' : '?') + combinedQuery(v);
      const res = await call('GET', full, { token: TOKEN });
      n++;
      if (typeof res.status === 'number' && res.status >= 500) record('GET-BOUND', 'GET', full, res.status, res.body);
    }
  }

  // 阶段 3：GET + 结构化 query
  for (const r of getRoutes) {
    if (dangerous(r.path)) continue;
    const base = fillPath(r.path);
    for (const q of STRUCT) {
      const full = base + (base.includes('?') ? '&' : '?') + q;
      const res = await call('GET', full, { token: TOKEN });
      n++;
      if (typeof res.status === 'number' && res.status >= 500) record('GET-STRUCT', 'GET', full, res.status, res.body);
    }
  }

  // 阶段 4：安全 POST 基线 + 单字段真实 JSON 类型替换
  for (const [path, base, fields] of SAFE_POST) {
    const b1 = await call('POST', path, { body: base, token: TOKEN });
    n++;
    console.log(`  基线 POST ${path} -> ${b1.status}`, { flush: true });
    if (typeof b1.status === 'number' && b1.status >= 500) record('POST-BASE', 'POST', path, b1.status, b1.body);
    for (const f of fields) {
      for (const v of BODY_TYPES) {
        const body = { ...base, [f]: v };
        const res = await call('POST', path, { body, token: TOKEN });
        n++;
        if (typeof res.status === 'number' && res.status >= 500) record('POST-TYPE', 'POST', `${path}#${f}`, res.status, res.body);
      }
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n### 合计 ${n} 用例，耗时 ${dt}s，5xx ${findings.length}`, { flush: true });
  const seen = new Set();
  for (const f of findings) {
    const k = f.tag + '|' + f.method + '|' + f.full.split('?')[0];
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  [${f.tag}] ${f.method} ${f.full} -> ${f.status}`, { flush: true });
  }
  console.log(findings.length === 0 ? '### 结论：未复现任何 5xx（潜伏缺陷扫描通过）' : `### 结论：发现 ${findings.length} 条 5xx 需修复`, { flush: true });
}

main().catch((e) => {
  console.error('Fuzz 异常:', e);
  process.exit(2);
});
