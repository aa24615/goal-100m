/**
 * v10 需求实现 —— 单元测试（RQ-119 ~ RQ-128）
 *
 * 优先级分层沿用 v7/v8 的约定（**P3/P4/P5 是测试级别，不是产品优先级**）：
 *   P0 主流程      —— 需求验收标准里写明的那条主路径
 *   P1 差异化      —— 与竞品/旧版不同的关键行为（公网判定、连打替代公榜、逐笔可核对）
 *   P2 留存体验    —— 用户会反复看到的表达层（日历、文案方向、缺口提示）
 *   P3 边界异常    —— null / 脏入参 / 断网 / 状态码异常
 *   P4 性能并发    —— 规模与并发下的稳定性
 *   P5 兼容回归    —— 不破坏 v9 既有调用方的行为
 *
 * 全部为纯函数测试，不连数据库、不发真实网络请求
 * （verifyRelease 的各项通过注入 fake fetch / fake query 验证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolvePublicAccess,
  isPublicIpv4,
  suggestEphemeralDomain,
  renderEnvSnippet,
} from '../../src/services/publicAccessService.js';
import {
  buildStreakRecord,
  buildNetWinBoard,
  PUBLIC_BOARD_MIN_ACTIVE_USERS,
  CHALLENGE_MIN_ROUNDS,
} from '../../src/services/dailyChallengeService.js';
import {
  buildSettlementSheet,
  buildOrderLine,
  feeBreakdown,
  SETTLEMENT_RULES,
} from '../../src/services/settlementService.js';
import { mobileReadiness } from '../../src/services/deviceService.js';
import { buildShareLink } from '../../src/services/attributionService.js';
import {
  checkBundleName,
  checkRoutes,
  checkTelemetry,
  checkErrorTable,
  checkErrorLogs,
  REQUIRED_ROUTES,
  PROBE_MARK,
} from '../../src/scripts/verifyRelease.js';

/* ------------------------------ 测试替身 ------------------------------ */

const HTML = (name) => `<!doctype html><html><head>
  <script type="module" crossorigin src="/assets/${name}"></script>
  <link rel="stylesheet" href="/assets/index-AAA.css">
</head><body><div id="root"></div></body></html>`;

function fakeFetch(map) {
  return async (url, init) => {
    const key = Object.keys(map).find((k) => String(url).includes(k));
    const v = key ? map[key] : { status: 404, body: '' };
    const status = v.status ?? 200;
    const body = typeof v.body === 'string' ? v.body : JSON.stringify(v.body ?? {});
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
}

function fakeQuery(handler) {
  return async (sql, params) => ({ rows: (await handler(sql, params)) || [] });
}

function tmpHtml(name) {
  const dir = mkdtempSync(join(tmpdir(), 'v10-'));
  const p = join(dir, 'index.html');
  writeFileSync(p, HTML(name));
  return p;
}

/* ============================ P0 · 主流程 ============================ */

test('P0 · RQ-122 未配置对外地址时判定不可达，并给出可执行的补全指引', () => {
  const a = resolvePublicAccess({});
  assert.equal(a.ready, false);
  assert.equal(a.publicUrl, null);
  assert.ok(a.blockers.length >= 1);
  assert.ok(a.blockers[0].includes('PUBLIC_BASE_URL'), 'blocker 必须指明该配哪个变量');
  assert.ok(a.nextAction.length > 0);
});

test('P0 · RQ-122 配置了合法 HTTPS 域名即判定公网可达', () => {
  const a = resolvePublicAccess({ PUBLIC_BASE_URL: 'https://train.example.com' });
  assert.equal(a.ready, true);
  assert.equal(a.host, 'train.example.com');
  assert.equal(a.https, true);
  assert.equal(a.publicUrl, 'https://train.example.com');
  assert.equal(a.blockers.length, 0);
});

test('P0 · RQ-121 发布后验证清单覆盖 v10 三个规范端点（public/guest/growth）', () => {
  const paths = REQUIRED_ROUTES.map((r) => r.path);
  for (const p of ['/api/public/access', '/api/guest/session', '/api/growth/funnel']) {
    assert.ok(paths.includes(p), `验证清单缺少 ${p}`);
  }
  // 需登录的端点允许 401：401 证明路由存在，404 才是没发上去
  const funnel = REQUIRED_ROUTES.find((r) => r.path === '/api/growth/funnel');
  assert.ok(funnel.allow.includes(401));
});

test('P0 · RQ-123 线上 bundle 与本地 dist 一致时判定通过', async () => {
  const p = tmpHtml('index-NEW123.js');
  const r = await checkBundleName({
    indexHtml: p,
    fetchFn: fakeFetch({ '/': { status: 200, body: HTML('index-NEW123.js') } }),
  });
  assert.equal(r.ok, true);
  assert.match(r.detail, /index-NEW123\.js/);
});

test('P0 · RQ-123 线上仍是旧包时判定失败并指明两侧文件名', async () => {
  const p = tmpHtml('index-NEW123.js');
  const r = await checkBundleName({
    indexHtml: p,
    fetchFn: fakeFetch({ '/': { status: 200, body: HTML('index-OLD999.js') } }),
  });
  assert.equal(r.ok, false, '包名不一致必须阻断发布');
  assert.match(r.detail, /index-OLD999\.js/);
  assert.match(r.detail, /index-NEW123\.js/);
});

test('P0 · RQ-125 有成交时结算说明书逐笔可核对，且费用审计通过', () => {
  // 费用按公开费率重算：BUY 10000 → 佣金 max(5, 3)=5 + 过户费 0.1 = 5.10
  //                     SELL 11000 → 佣金 max(5, 3.3)=5 + 印花税 5.5 + 过户费 0.11 = 10.61
  const sheet = buildSettlementSheet({
    orders: [
      { seq: 1, side: 'BUY', quantity: 1000, price: 10, amount: 10000, fee: 5.1, realized_pnl: 0 },
      { seq: 2, side: 'SELL', quantity: 1000, price: 11, amount: 11000, fee: 10.61, realized_pnl: 977.79 },
    ],
    session: { status: 'FINISHED' },
    score: { returnPct: 1.2, buyHoldPct: 0.8 },
  });
  assert.equal(sheet.orderCount, 2);
  assert.equal(sheet.finished, true);
  assert.equal(sheet.applicable, true);
  assert.equal(sheet.feeAudit.ok, true, '记账费用应与按公开费率重算一致');
  assert.equal(sheet.feeAudit.mismatch, 0);
  assert.ok(sheet.reconciliation.includes('卖出回款'), '必须给出可以对账的总账式说明');
  assert.ok(sheet.orders[0].text.includes('@ ¥10.00'));
});

test('P0 · RQ-126 连打记录给出日历与周对比（公榜关闭后的默认留存钩子）', () => {
  // 固定基准日，避免用例在跨日边界上抖动
  const now = new Date('2026-10-29T10:00:00+08:00');
  const days = ['2026-10-28', '2026-10-27'];
  const r = buildStreakRecord(days, { now, windowDays: 28 });
  assert.equal(r.calendar.length, 28, '日历长度应等于窗口天数');
  assert.equal(r.calendar[r.calendar.length - 1].date, '2026-10-29', '日历最后一天应为今天');
  assert.equal(r.thisWeek, 2, '本周（近 7 天）应有 2 天');
  assert.equal(r.lastWeek, 0, '上周同期应为 0 天');
  assert.equal(r.delta, 2);
  assert.match(r.comparison, /比上周同期多 2 天/);
  assert.equal(r.current, 2, '连续天数应为 2（27、28 连续且 28 距今 1 天）');
});

/* ============================ P1 · 差异化 ============================ */

test('P1 · RQ-122 localhost 与内网地址一律判为不可对外（防自欺）', () => {
  for (const host of ['localhost', '127.0.0.1', '192.168.1.10', '10.0.0.5', '172.16.0.9', '169.254.1.1']) {
    const a = resolvePublicAccess({ PUBLIC_BASE_URL: `https://${host}` });
    assert.equal(a.ready, false, `${host} 不应被判定为公网可达`);
    assert.ok(a.blockers.some((b) => b.includes('本机/内网')));
  }
});

test('P1 · RQ-122 明文 HTTP 域名被判为 blocker（公网入口默认 HTTPS）', () => {
  const a = resolvePublicAccess({ PUBLIC_BASE_URL: 'http://train.example.com' });
  assert.equal(a.ready, false);
  assert.ok(a.blockers.some((b) => b.includes('HTTPS')));
});

test('P1 · RQ-122 无自有域名时给出可立即执行的过渡域名与 .env 片段', () => {
  assert.equal(isPublicIpv4('8.8.8.8'), true);
  assert.equal(isPublicIpv4('10.0.0.1'), false);
  assert.equal(isPublicIpv4('not-an-ip'), false);
  // 文档保留段（203.0.113/198.51.100）不得被当成公网出口
  assert.equal(isPublicIpv4('203.0.113.10'), false);
  const domain = suggestEphemeralDomain('8.8.8.8');
  assert.ok(domain && domain.includes('nip.io'), '应给出免费泛解析过渡域名');
  const env = renderEnvSnippet({ host: domain });
  assert.match(env, /^PUBLIC_BASE_URL=https:\/\//m);
  assert.equal(suggestEphemeralDomain('192.168.0.1'), null, '内网 IP 不得生成过渡域名');
});

test('P1 · RQ-125 结算说明书覆盖全部五条关键规则（T+1/涨跌停/整手/费用/滑点）', () => {
  const keys = SETTLEMENT_RULES.map((r) => r.key);
  for (const k of ['t1', 'limit', 'lot', 'fee', 'slippage', 'price']) {
    assert.ok(keys.includes(k), `缺少规则 ${k}`);
  }
  for (const r of SETTLEMENT_RULES) {
    assert.ok(r.body.length > 0, `${r.key} 缺少说明正文`);
    assert.ok(r.verifiable.length > 0, `${r.key} 缺少可核对方式`);
  }
  const sheet = buildSettlementSheet({ orders: [], session: { status: 'FINISHED' } });
  assert.equal(sheet.rules.length, SETTLEMENT_RULES.length);
  assert.ok(sheet.text.includes('滑点'), '纯文本版也必须包含滑点口径');
});

test('P1 · RQ-125 滑点如实写「无滑点模型」，不假装有滑点', () => {
  const slip = SETTLEMENT_RULES.find((r) => r.key === 'slippage');
  assert.match(slip.body, /不引入滑点|无滑点/);
});

test('P1 · RQ-126 活跃用户不足时公榜不产出内容，并说明原因而非空壳', () => {
  const board = buildNetWinBoard(
    [
      { ref: 'u1', displayName: '甲', rounds: 10, netWin: 5 },
      { ref: 'u2', displayName: '乙', rounds: 6, netWin: 3 },
    ],
    { activeUsers: 9 }
  );
  assert.equal(board.publicBoardEnabled, false);
  assert.equal(board.board.length, 0, '未达门槛不得产出榜单');
  assert.equal(board.participants, 0);
  assert.ok(board.boardReason && board.boardReason.includes(String(PUBLIC_BOARD_MIN_ACTIVE_USERS)));
});

/* ============================ P2 · 留存体验 ============================ */

test('P2 · RQ-126 周对比文案三种方向都不出现歧义', () => {
  const now = new Date('2026-10-29T10:00:00+08:00');
  const up = buildStreakRecord(['2026-10-28', '2026-10-29'], { now });
  assert.match(up.comparison, /多 2 天/);

  const flat = buildStreakRecord(['2026-10-22', '2026-10-28'], { now });
  assert.equal(flat.delta, 0);
  assert.match(flat.comparison, /持平/);

  const down = buildStreakRecord(['2026-10-21', '2026-10-22'], { now });
  assert.ok(down.delta < 0);
  assert.match(down.comparison, /少 2 天/);
  assert.ok(!down.comparison.includes('少 -'), '不得输出「少 -2 天」这类双重否定');
});

test('P2 · RQ-126 日历按升序排列且每天都给出是否参与（空也要给全）', () => {
  const now = new Date('2026-10-29T10:00:00+08:00');
  const r = buildStreakRecord(['2026-10-25'], { now, windowDays: 14 });
  const dates = r.calendar.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort(), '日历应升序');
  assert.equal(dates.length, 14);
  assert.equal(r.calendar.filter((d) => d.participated).length, 1);
  assert.equal(r.metric, '参与天数');
});

test('P2 · RQ-128 无公网地址时分享链接明确拒绝，不返回 localhost 链接', () => {
  const r = buildShareLink({ baseUrl: null, channel: 'community' });
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0);
  assert.equal(String(r.url ?? '').includes('localhost'), false, '不得产出不可对外分享的 localhost 链接');
});

test('P2 · RQ-127 移动端未实测时判定未就绪，且列出缺失项', () => {
  const r = mobileReadiness();
  assert.equal(r.ready, false, '真机走查完成前不应显示就绪');
  assert.ok(r.missing.length > 0);
  assert.ok(r.note.includes('真机') || r.note.includes('未实测'));
});

/* ============================ P3 · 边界异常 ============================ */

test('P3 · RQ-125 脏入参不抛错，且给出可读文案而不是 NaN', () => {
  for (const bad of [null, undefined, {}, { orders: null }, { orders: 'x', session: null }]) {
    const s = buildSettlementSheet(bad);
    assert.equal(typeof s.summary, 'string');
    assert.ok(!JSON.stringify(s.totals).includes('null'), 'totals 不得为 null');
  }
  const empty = buildSettlementSheet({ orders: [], session: { status: 'RUNNING' } });
  assert.match(empty.summary, /没有成交/);
  assert.equal(empty.applicable, false, '未完成的局不应出具完整结算说明');
});

test('P3 · RQ-125 单笔明细对缺失/非法字段降级为占位符', () => {
  const l = buildOrderLine(null, 0);
  assert.equal(l.index, 1);
  assert.equal(l.quantity, 0);
  assert.equal(l.sideLabel, '未知');
  assert.match(l.text, /—/);

  const bad = buildOrderLine({ side: 'SELL', quantity: 'abc', price: null, amount: NaN }, 2);
  assert.equal(bad.quantity, 0);
  assert.equal(bad.price, null);
  assert.equal(bad.fee, 0, '金额非法时费用应为 0 而不是 NaN');
});

test('P3 · RQ-125 最低佣金触发时明确标注，避免用户以为是算错了', () => {
  const f = feeBreakdown(1000, 'BUY'); // 1000*0.0003=0.3 < 5
  assert.equal(f.minCommissionApplied, true);
  assert.equal(f.commission, 5);
  const l = buildOrderLine({ side: 'BUY', quantity: 100, price: 10, amount: 1000, fee: 5.01 }, 0);
  assert.ok(l.text.includes('最低佣金'));
});

test('P3 · RQ-123 线上不可达时验证失败并带原因，而不是静默通过', async () => {
  const p = tmpHtml('index-A.js');
  const r = await checkBundleName({
    indexHtml: p,
    fetchFn: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test('P3 · RQ-123 埋点返回 200 但未落库时判定失败（状态码不能代替落库）', async () => {
  const r = await checkTelemetry({
    fetchFn: fakeFetch({ '/api/analytics/error': { status: 200, body: { ok: true } } }),
    queryFn: fakeQuery(async () => []),
  });
  assert.equal(r.ok, false, '接口正常但没落库，等于埋点不可用');
  assert.match(r.detail, /未落库/);
});

test('P3 · RQ-123 埋点探针写完即清理，不污染错误统计', async () => {
  const calls = [];
  const r = await checkTelemetry({
    fetchFn: fakeFetch({ '/api/analytics/error': { status: 200, body: { ok: true } } }),
    queryFn: fakeQuery(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT')) return [{ id: 1 }];
      return [];
    }),
  });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.sql.includes('DELETE')), '必须删除探针记录');
  assert.ok(calls.some((c) => c.params?.[0] === PROBE_MARK));
});

test('P3 · RQ-123 错误表新增计数来自 created_at 大于发布时刻的条目', async () => {
  const since = new Date('2026-10-29T00:00:00Z');
  const clean = await checkErrorTable({ queryFn: fakeQuery(async () => [{ c: 0 }]), since });
  assert.equal(clean.ok, true);
  const dirty = await checkErrorTable({ queryFn: fakeQuery(async () => [{ c: 3 }]), since });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.count, 3);
});

test('P3 · RQ-123 日志含无法解析的行时保守计入 ERROR（宁可多报不漏报）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v10-log-'));
  const p = join(dir, 'app-2026-10-29.log');
  writeFileSync(
    p,
    [
      `{"level":"ERROR","time":"2026-10-29T01:00:00.000Z","msg":"旧错误"}`,
      `这不是 JSON 但含 "level":"ERROR"`,
      `{"level":"INFO","time":"2026-10-29T05:00:00.000Z","msg":"正常"}`,
    ].join('\n')
  );
  const r = checkErrorLogs({ since: new Date('2026-10-29T04:00:00Z'), dir });
  assert.equal(r.ok, false);
  assert.equal(r.count, 1, '非 JSON 行保守计入；早于发布时刻的旧错误不计入');
});

test('P3 · RQ-126 连打记录对空参与与非法日期不抛错', () => {
  const now = new Date('2026-10-29T10:00:00+08:00');
  for (const bad of [null, undefined, [], ['not-a-date'], ['', null]]) {
    const r = buildStreakRecord(bad, { now });
    assert.equal(r.calendar.length, 28);
    assert.equal(r.thisWeek, 0);
    assert.equal(r.current, 0);
  }
  // 入参本身不是对象时也要兜住（v8 踩过 f(null) 的 TypeError）
  const r2 = buildStreakRecord(['2026-10-28'], null);
  assert.equal(r2.calendar.length, 28);
});

test('P3 · RQ-123 路由检查遇到非预期状态码时逐条列出', async () => {
  const r = await checkRoutes({
    fetchFn: fakeFetch({ '/api/public/access': { status: 404 } }),
    routes: [{ path: '/api/public/access', allow: [200], label: 'x' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /404/);
});

/* ============================ P4 · 性能与并发 ============================ */

test('P4 · RQ-125 1000 笔成交的结算说明书构建不退化', () => {
  const orders = Array.from({ length: 1000 }, (_, i) => ({
    seq: i + 1,
    side: i % 2 === 0 ? 'BUY' : 'SELL',
    quantity: 100,
    price: 10 + (i % 5),
    amount: (10 + (i % 5)) * 100,
    fee: 5,
    realized_pnl: i % 7,
  }));
  const t0 = Date.now();
  const sheet = buildSettlementSheet({ orders, session: { status: 'FINISHED' } });
  const ms = Date.now() - t0;
  assert.equal(sheet.orderCount, 1000);
  assert.ok(ms < 2000, `1000 笔构建耗时 ${ms}ms，超过预算`);
});

test('P4 · RQ-126 连打记录 20000 次构建不退化且结果稳定', () => {
  const days = ['2026-10-20', '2026-10-21', '2026-10-28'];
  const now = new Date('2026-10-29T10:00:00+08:00');
  const t0 = Date.now();
  let last = null;
  for (let i = 0; i < 20000; i += 1) last = buildStreakRecord(days, { now });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `20000 次耗时 ${ms}ms，超过预算`);
  assert.equal(last.thisWeek, 1);
  assert.equal(last.longest, 2);
});

test('P4 · RQ-123 并发 50 次路由检查互不干扰（检查函数无共享状态）', async () => {
  const fetchFn = fakeFetch({ '/api/public/access': { status: 200 }, '/api/guest/session': { status: 200 } });
  const routes = [
    { path: '/api/public/access', allow: [200], label: 'a' },
    { path: '/api/guest/session', allow: [200], label: 'b' },
  ];
  const results = await Promise.all(Array.from({ length: 50 }, () => checkRoutes({ fetchFn, routes })));
  assert.equal(results.length, 50);
  assert.ok(results.every((r) => r.ok === true), '并发执行结果必须全部一致');
});

/* ============================ P5 · 兼容回归 ============================ */

test('P5 · RQ-126 不传 activeUsers 时榜单行为与 v9 完全一致（保护既有调用方）', () => {
  const entries = [
    { ref: 'u1', displayName: '甲', rounds: 10, netWin: 5 },
    { ref: 'u2', displayName: '乙', rounds: 6, netWin: 3 },
    { ref: 'u3', displayName: '丙', rounds: 2, netWin: 1 },
  ];
  const board = buildNetWinBoard(entries);
  assert.equal(board.publicBoardEnabled, true, '未统计活跃用户 ≠ 活跃用户为 0');
  assert.equal(board.board.length, 2, '未达 5 局的不进榜（v9 行为）');
  assert.equal(board.board[0].rank, 1);
  assert.equal(board.waiting.length, 1);
  assert.equal(board.waiting[0].remaining, CHALLENGE_MIN_ROUNDS - 2);
  // 硬约束 6：榜单序列化结果里不得出现任何收益率字段
  assert.equal(/returnPct|return_pct|收益率/.test(JSON.stringify(board)), false);
});

test('P5 · RQ-122 checklist 仍为 5 项且 key 集合不变（v9 调用方依赖）', () => {
  const a = resolvePublicAccess({ PUBLIC_BASE_URL: 'https://train.example.com' });
  const keys = a.checklist.map((c) => c.key);
  assert.deepEqual(keys, ['dns', 'https', 'proxy', 'readme', 'smoke']);
  // readme / smoke 无法从环境变量推导，默认未完成
  assert.equal(a.checklist.find((c) => c.key === 'readme').done, false);
  assert.equal(a.checklist.find((c) => c.key === 'smoke').done, false);
});

test('P5 · RQ-122 readme/smoke 可由调用方显式声明完成（部署脚本留痕）', () => {
  const a = resolvePublicAccess({ PUBLIC_BASE_URL: 'https://train.example.com' }, { readme: true, smoke: true });
  assert.equal(a.checklist.find((c) => c.key === 'readme').done, true);
  assert.equal(a.checklist.find((c) => c.key === 'smoke').done, true);
});

test('P5 · RQ-125 未揭示的训练不输出标的代码（与双盲同一条红线）', () => {
  const sheet = buildSettlementSheet({
    orders: [{ seq: 1, side: 'BUY', quantity: 100, price: 10, amount: 1000, fee: 5, stock_code: '600001', stock_name: 'X' }],
    session: { status: 'RUNNING' },
    reveal: false,
  });
  assert.equal(sheet.reveal, false);
  assert.equal(sheet.orders[0].code, null);
  assert.equal(sheet.orders[0].name, null);
  assert.equal(JSON.stringify(sheet).includes('600001'), false, '未揭示时不得出现标的代码');
});

test('P5 · RQ-121 验证清单保留 v9 已有路径，不因改造而丢失旧端点', () => {
  const paths = REQUIRED_ROUTES.map((r) => r.path);
  assert.ok(paths.includes('/api/config/public-access'), 'v9 路径仍需被验证');
  assert.ok(paths.includes('/api/analytics/north-star'), '北极星端点仍需被验证');
  assert.ok(paths.includes('/api/rooms'), '已下线路由应验证为 410 而非 404');
});
