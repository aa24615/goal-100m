/**
 * v13 需求单测（RQ-156 / 157 / 158 / 159 / 160 / 172）
 *
 * 优先级约定沿用 v7：需求文档只定义 P0/P1/P2，
 * **P3 边界异常 / P4 性能并发 / P5 兼容回归是测试级别，不是产品优先级**。
 *
 * v13 的头号结论是「屋里设备都通电了，但读数全是我们自己按出来的开关」，
 * 因此本文件的断言重心不在「算得对不对」，而在三件事：
 *   ① 公网入口的**责任人**能不能被断言（RQ-160）；
 *   ② 测试流量是不是**默认就看不见**（RQ-157）；
 *   ③ 埋点与业务表对不上时会不会**自己喊出来**（RQ-158）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  upsertEnvVar,
  ownerState,
  frozenGate,
  validateDomain,
  buildProvisionPlan,
  summarizePublicEntry,
  renderReadmeEntry,
  FROZEN_RQS,
  DEADLINE_WARN_DAYS,
} from '../../src/services/publicEntryService.js';

import {
  TRAFFIC_SCOPES,
  DEFAULT_TRAFFIC_SCOPE,
  trafficScopeWhere,
  trafficScopeJoin,
  boardScopeOf,
  classifyIngest,
  scanMissingTestFilter,
  auditResumeDedupe,
  auditTestIsolation,
  pickDuplicateResumeIds,
  collectSourceFiles,
  MARK_SQL,
  SCOPE_WINDOW_CHARS,
} from '../../src/services/testIsolationService.js';

import {
  reconcileConsistency,
  checkTelemetryConsistency,
  verificationStreak,
  recordVerification,
  REQUIRED_VERIFY_STREAK,
} from '../../src/services/releaseGateService.js';

import {
  normalizeInviteCode,
  newInviteCode,
  buildInviteLink,
  planInvites,
  inviteePath,
  summarizeInviteFunnel,
  INVITE_GOAL,
  INVITE_STEPS,
  MAX_BATCH,
} from '../../src/services/inviteService.js';

import { runProvision, provisionOwnerOnly, parseArgs } from '../../src/scripts/provisionPublicEntry.js';
import { checkPublicOwner } from '../../src/scripts/releaseCheck.js';
import {
  checkConsistency,
  checkVerificationRecord,
  gitHead,
  runVerify,
  REQUIRED_ROUTES,
} from '../../src/scripts/verifyRelease.js';

/* ================================================================== *
 * RQ-156 公网入口（可断言 + 可落地）                                   *
 * ================================================================== */

test('P0 · RQ-156 合法域名产出完整落地计划，且对外地址为 https', () => {
  const p = buildProvisionPlan({ domain: 'train.example.com', email: 'me@example.com' });
  assert.equal(p.ok, true);
  assert.equal(p.domain, 'train.example.com');
  assert.equal(p.publicUrl, 'https://train.example.com');
  const ids = p.steps.map((s) => s.id);
  // env / nginx / cert / reload / verify 五步缺一步就等于没装
  for (const id of ['env', 'nginx', 'cert', 'reload', 'verify']) {
    assert.ok(ids.includes(id), `落地计划缺少 ${id} 步`);
  }
  const cert = p.steps.find((s) => s.id === 'cert');
  assert.match(cert.command, /-m me@example\.com/);
});

test('P0 · RQ-156 无自有域名时接受 nip.io 过渡域名', () => {
  const v = validateDomain('203.0.113.10.nip.io');
  assert.equal(v.ok, true);
  assert.equal(v.host, '203.0.113.10.nip.io');
});

test('P0 · RQ-156 localhost / 内网地址一律拒绝（自欺式配置）', () => {
  for (const bad of ['localhost', '127.0.0.1', 'http://192.168.1.5:8080', '', null, undefined]) {
    const v = validateDomain(bad);
    assert.equal(v.ok, false, `${bad} 不应被判为可用域名`);
    assert.ok(v.reason, '拒绝时必须给出可读理由');
  }
});

test('P0 · RQ-156 upsertEnvVar 幂等：重复执行不产生第二行', () => {
  let t = 'JWT_SECRET=keep-me\n';
  t = upsertEnvVar(t, 'PUBLIC_BASE_URL', 'https://a.example.com');
  const once = t;
  t = upsertEnvVar(t, 'PUBLIC_BASE_URL', 'https://b.example.com');
  const matches = t.match(/^PUBLIC_BASE_URL=/gm) || [];
  assert.equal(matches.length, 1, '重复写入不得产生第二行');
  assert.match(t, /PUBLIC_BASE_URL=https:\/\/b\.example\.com/);
  assert.match(once, /JWT_SECRET=keep-me/);
});

test('P1 · RQ-156 upsertEnvVar 保留注释、空行与其余键（手写重写会吞掉它们）', () => {
  const src = '# 顶部注释\nJWT_SECRET=x\n\n# 分组标题\nOTHER=1\n';
  const out = upsertEnvVar(src, 'PUBLIC_BASE_URL', 'https://a.example.com', { comment: 'RQ-156' });
  assert.match(out, /# 顶部注释/);
  assert.match(out, /# 分组标题/);
  assert.match(out, /OTHER=1/);
  assert.match(out, /# RQ-156/);
});

test('P0 · RQ-156 当前生产形态（仅 JWT_SECRET + server_name _）应被判为未就绪', () => {
  const s = summarizePublicEntry({
    envText: 'JWT_SECRET=xxx\n',
    nginxText: 'server { listen 80; server_name _; }',
    readmeText: '# 项目\n入口：http://localhost:8080\n',
    now: new Date('2026-11-02T00:00:00+08:00'),
  });
  assert.equal(s.ready, false);
  assert.equal(s.audit.ready, false);
  assert.ok(s.audit.blockers.length > 0);
  // 没有 owner 时 ready 必须为 false：连续四版未完成的根因正在这里
  assert.equal(s.owner.state, 'none');
  assert.equal(s.owner.blocked, true);
  assert.equal(s.gate.ok, false);
});

test('P1 · RQ-156 三处文件全部配齐 + 有责任人时判定就绪', () => {
  const s = summarizePublicEntry({
    envText: [
      'JWT_SECRET=xxx',
      'PUBLIC_BASE_URL=https://train.example.com',
      'PUBLIC_ENTRY_OWNER=zyan',
      'PUBLIC_ENTRY_DEADLINE=2026-12-31',
    ].join('\n'),
    nginxText: 'server { listen 443 ssl; server_name train.example.com; }\nserver { listen 80; server_name train.example.com; return 301 https://$host$request_uri; }',
    readmeText: '## 公网入口\n- **对外唯一入口**：https://train.example.com\n| 责任人（RQ-160） | `zyan` |\n',
    smoke: true,
    now: new Date('2026-11-02T00:00:00+08:00'),
  });
  assert.equal(s.audit.ready, true);
  assert.equal(s.owner.blocked, false);
  assert.equal(s.gate.ok, true);
  assert.equal(s.ready, true);
});

test('P3 · RQ-156 空输入 / 非法入参不抛错（诊断类函数的底线）', () => {
  // 空文本时是「新增」而不是「无操作」；空键名才是无操作
  assert.equal(upsertEnvVar(null, 'A', '1'), 'A=1\n');
  assert.equal(upsertEnvVar('A=1\n', '', '1'), 'A=1\n');
  assert.equal(validateDomain(null).ok, false);
  assert.equal(buildProvisionPlan(null).ok, false);
  const s = summarizePublicEntry();
  assert.equal(s.ready, false);
  assert.ok(Array.isArray(s.audit.blockers));
});

test('P3 · RQ-156 重复定义的键只保留第一次出现的那行', () => {
  const out = upsertEnvVar('PUBLIC_BASE_URL=https://a.example.com\nPUBLIC_BASE_URL=https://b.example.com\n', 'PUBLIC_BASE_URL', 'https://c.example.com');
  const lines = out.split('\n').filter((l) => l.startsWith('PUBLIC_BASE_URL='));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'PUBLIC_BASE_URL=https://c.example.com');
});

test('P5 · RQ-156 upsertEnvVar 兼容引号包裹的值，不产生 KEY="v" 的嵌套引号', () => {
  const out = upsertEnvVar('PUBLIC_BASE_URL="https://old.example.com"\n', 'PUBLIC_BASE_URL', 'https://new.example.com');
  assert.match(out, /PUBLIC_BASE_URL=https:\/\/new\.example\.com$/m);
  assert.equal(out.includes('"https://new.example.com"'), false);
});

/* ================================================================== *
 * RQ-160 责任人闭环                                                    *
 * ================================================================== */

test('P0 · RQ-160 未指定 owner 即阻断（连续四版未完成的根因）', () => {
  const o = ownerState({ now: new Date('2026-11-02T00:00:00+08:00') });
  assert.equal(o.state, 'none');
  assert.equal(o.blocked, true);
  assert.match(o.note, /责任人|owner/);
});

test('P0 · RQ-160 逾期必须被判为阻断并给出逾期天数', () => {
  const o = ownerState({ owner: 'zyan', deadline: '2026-10-01', now: new Date('2026-11-02T00:00:00+08:00') });
  assert.equal(o.state, 'overdue');
  assert.equal(o.blocked, true);
  assert.equal(o.daysLeft < 0, true);
  assert.match(o.note, /逾期 \d+ 天/);
});

test('P1 · RQ-160 五种状态各自可辨（补救动作完全不同）', () => {
  const now = new Date('2026-11-02T00:00:00+08:00');
  assert.equal(ownerState({ owner: 'a', now }).state, 'no-deadline');
  assert.equal(ownerState({ deadline: '2026-12-01', now }).state, 'no-owner');
  assert.equal(ownerState({ owner: 'a', deadline: '2026-11-04', now }).state, 'due-soon');
  assert.equal(ownerState({ owner: 'a', deadline: '2026-12-01', now }).state, 'ok');
  assert.equal(ownerState({ owner: 'a', deadline: '2026-11-04', now }).blocked, false);
  assert.equal(ownerState({ deadline: '2026-12-01', now }).blocked, true);
});

test('P3 · RQ-160 非法日期 / 非法 now 不抛错，且保留原值便于排障', () => {
  const o = ownerState({ owner: 'a', deadline: 'not-a-date', now: new Date('2026-11-02T00:00:00+08:00') });
  assert.equal(o.deadline, 'not-a-date');
  assert.equal(o.daysLeft, null);
  assert.equal(o.state, 'no-deadline');
  const o2 = ownerState({ owner: 'a', deadline: '2026-12-01', now: null });
  assert.ok(['ok', 'due-soon', 'overdue'].includes(o2.state));
});

test('P5 · RQ-160 纯日期截止日按上海时区当天末尾计算，不因 UTC 差一天', () => {
  // now = 上海 11-02 23:00：按「当天 23:59:59 +08」算还有 1 小时，不该逾期；
  // 若按 UTC 午夜解析（= 上海 08:00），此时已过去 15 小时，会被误判逾期。
  const o = ownerState({ owner: 'a', deadline: '2026-11-02', now: new Date('2026-11-02T23:00:00+08:00') });
  assert.equal(o.state, 'due-soon', '当天未过完不得判为逾期');
  assert.equal(o.daysLeft > 0, true);
  assert.equal(DEADLINE_WARN_DAYS, 3);
  // 同一个截止日在次日同一时刻确实已逾期，证明判据本身有效（不是恒为 due-soon）
  assert.equal(ownerState({ owner: 'a', deadline: '2026-11-02', now: new Date('2026-11-04T00:00:00+08:00') }).state, 'overdue');
});

/* ================================================================== *
 * RQ-172 冻结护栏                                                      *
 * ================================================================== */

test('P0 · RQ-172 公网未就绪时 RQ-161~170 全部冻结', () => {
  const g = frozenGate({ publicReady: false });
  assert.equal(g.ok, false);
  assert.deepEqual(g.blocked, FROZEN_RQS);
  assert.equal(g.allowed.length, 0);
  assert.match(g.note, /不得扩张/);
});

test('P0 · RQ-172 公网就绪后冻结解除', () => {
  const g = frozenGate({ publicReady: true });
  assert.equal(g.ok, true);
  assert.equal(g.blocked.length, 0);
  assert.equal(g.allowed.length, FROZEN_RQS.length);
});

test('P1 · RQ-172 只冻结名单内的需求，本期开工项不受影响', () => {
  const g = frozenGate({ publicReady: false, requested: ['RQ-156', 'RQ-157', 'RQ-161'] });
  assert.deepEqual(g.blocked, ['RQ-161']);
  assert.deepEqual(g.allowed, ['RQ-156', 'RQ-157']);
  assert.equal(g.ok, false);
});

test('P3 · RQ-172 大小写 / 空格 / 空数组 / 非法入参都收敛', () => {
  assert.deepEqual(frozenGate({ publicReady: false, requested: ['rq-161', ' RQ-162 '] }).blocked, ['RQ-161', 'RQ-162']);
  assert.deepEqual(frozenGate({ publicReady: false, requested: [] }).blocked, FROZEN_RQS);
  assert.deepEqual(frozenGate({ publicReady: false, requested: 'RQ-161' }).blocked, FROZEN_RQS);
  assert.equal(frozenGate(null).publicReady, false);
});

test('P5 · RQ-172 冻结清单常量锁（范围只能由需求表显式变更）', () => {
  assert.deepEqual(FROZEN_RQS, ['RQ-161', 'RQ-162', 'RQ-163', 'RQ-164', 'RQ-165', 'RQ-166', 'RQ-167', 'RQ-168', 'RQ-169', 'RQ-170']);
});

/* ================================================================== *
 * RQ-157 自测流量隔离                                                  *
 * ================================================================== */

test('P0 · RQ-157 默认口径是 real，测试流量默认不可见', () => {
  assert.equal(DEFAULT_TRAFFIC_SCOPE, TRAFFIC_SCOPES.real);
  const w = trafficScopeWhere({ eventAlias: 'e', userAlias: 'u' });
  assert.match(w, /e\.is_test = FALSE/);
  assert.match(w, /COALESCE\(u\.is_test, FALSE\) = FALSE/);
  // 双重判定是 AND：事件没打标但用户打了标，仍然不算真实流量
  assert.match(w, / AND /);
});

test('P0 · RQ-157 test 口径取并集（一次看清全部污染规模）', () => {
  const w = trafficScopeWhere({ scope: 'test' });
  assert.match(w, / OR /);
  assert.equal(trafficScopeWhere({ scope: 'all' }), 'TRUE');
});

test('P0 · RQ-157 口径必须显式 LEFT JOIN users（只判事件列会漏掉已打标用户）', () => {
  const j = trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' });
  assert.match(j, /LEFT JOIN users u ON u\.id = e\.user_id/);
});

test('P0 · RQ-157 写入侧四类特征判为自测流量', () => {
  assert.equal(classifyIngest({ isTest: true }).isTest, true);
  assert.equal(classifyIngest({ user: { is_test: true, test_reason: '同秒批量注册' } }).isTest, true);
  assert.equal(classifyIngest({ headers: { 'user-agent': 'Mozilla/5.0 HeadlessChrome/120' } }).isTest, true);
  assert.equal(classifyIngest({ headers: { 'user-agent': 'python-requests/2.31' } }).isTest, true);
  assert.equal(classifyIngest({ privateIp: true }).isTest, true);
  assert.equal(classifyIngest({ headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' } }).isTest, false);
});

test('P1 · RQ-157 强证据优先，理由不串成一串', () => {
  const r = classifyIngest({
    isTest: true,
    user: { is_test: true },
    headers: { 'user-agent': 'curl/8.0' },
    privateIp: true,
  });
  assert.equal(r.source, 'declared');
  assert.equal(r.reason, '显式声明为测试流量');
});

test('P3 · RQ-157 classifyIngest 空入参 / 脏入参不抛错', () => {
  assert.equal(classifyIngest().isTest, false);
  assert.equal(classifyIngest(null).isTest, false);
  assert.equal(classifyIngest({ body: null, headers: null, user: null }).isTest, false);
  assert.equal(classifyIngest({ headers: { 'user-agent': null } }).isTest, false);
});

test('P0 · RQ-157 历史 blind_resume 重复只保留最早一条（715 条形态）', () => {
  const rows = [
    { id: 1, subject: 'u3', session_id: '324' },
    { id: 2, subject: 'u3', session_id: '324' },
    { id: 3, subject: 'u3', session_id: '324' },
    { id: 4, subject: 'u3', session_id: '325' },
  ];
  assert.deepEqual(pickDuplicateResumeIds(rows), [2, 3]);
});

test('P1 · RQ-157 不同会话互不误削，缺 sessionId 的行不参与去重', () => {
  const rows = [
    { id: 1, subject: 'u3', session_id: '1' },
    { id: 2, subject: 'u3', session_id: '2' },
    { id: 3, subject: 'g1', session_id: null },
    { id: 4, subject: 'g1', session_id: null },
  ];
  assert.deepEqual(pickDuplicateResumeIds(rows), []);
});

test('P1 · RQ-157 会话级打标补齐「会话标了、事件没标」的缺口（RQ-158 实测抓到的那一条）', () => {
  // 会话被判为自测、但埋点行没标：对账时会被误报成「埋点记了不存在的会话」
  assert.match(MARK_SQL.sessionMarked, /FROM blind_sessions s/);
  assert.match(MARK_SQL.sessionMarked, /s\.is_test = TRUE/);
  assert.match(MARK_SQL.sessionMarked, /s\.id = NULLIF\(e\.payload->>'sessionId',''\)::int/);
  assert.match(MARK_SQL.sessionMarked, /e\.is_test = FALSE/, '已打标的事件不重复改写');
  assert.match(MARK_SQL.countSessionMarked, /COUNT\(\*\)/);
});

test('P3 · RQ-157 pickDuplicateResumeIds 空入参与非数组返回空数组', () => {
  assert.deepEqual(pickDuplicateResumeIds(null), []);
  assert.deepEqual(pickDuplicateResumeIds('x'), []);
  assert.deepEqual(pickDuplicateResumeIds([null, {}]), []);
});

test('P0 · RQ-157 缺失口径过滤器的查询按「每条查询」被抓（v12 真实缺陷）', () => {
  const files = [
    {
      path: 'src/services/analyticsService.js',
      text: [
        'export async function a() {',
        '  return pool.query(`SELECT COUNT(*) FROM analytics_events WHERE event=$1`);',
        '}',
        'export async function b() {',
        '  return pool.query(`SELECT COUNT(*) FROM analytics_events e',
        `    WHERE ${trafficScopeWhere({ scope: 'real' })}\`);`,
        '}',
      ].join('\n'),
    },
  ];
  const r = scanMissingTestFilter(files);
  assert.equal(r.ok, false);
  assert.equal(r.offenders.length, 1, '只有未声明口径的那条被抓');
  assert.equal(r.checked, 2);
  assert.match(r.offenders[0].problem, /测试流量会混入看板/);
});

test('P1 · RQ-157 豁免名单内的文件不报缺陷，但仍记录在 exempt 里（可见即可审）', () => {
  const files = [
    { path: 'src/services/telemetryIntegrityService.js', text: 'SELECT 1 FROM analytics_events WHERE x=1' },
  ];
  const r = scanMissingTestFilter(files);
  assert.equal(r.ok, true);
  assert.equal(r.exempt.length, 1);
  assert.ok(r.exempt[0].reason);
});

test('P1 · RQ-157 写入类语句（INSERT/DELETE/UPDATE）不算读点，不误报', () => {
  const files = [
    { path: 'src/services/x.js', text: 'DELETE FROM analytics_events WHERE created_at < now() - interval \'180 days\'' },
    { path: 'src/services/y.js', text: 'INSERT INTO analytics_events (event) SELECT event FROM analytics_events' },
  ];
  const r = scanMissingTestFilter(files);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test('P3 · RQ-157 scanMissingTestFilter 空入参不抛错', () => {
  const r = scanMissingTestFilter(null);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
  assert.equal(scanMissingTestFilter([{ path: 'a.js', text: '' }]).checked, 0);
});

test('P0 · RQ-157 auditResumeDedupe 超过 1 条即报违规', () => {
  const r = auditResumeDedupe([
    { subject: 'u3', sessionId: '324', count: 3 },
    { subject: 'u3', sessionId: '325', count: 1 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].over, 2);
  assert.equal(auditResumeDedupe([{ subject: 'a', sessionId: '1', count: 1 }]).ok, true);
});

test('P0 · RQ-157 一条测试事件都没有时判为阻断（说明打标从未执行）', () => {
  const a = auditTestIsolation({ scopeCounts: { real: 4521, test: 0 } });
  assert.equal(a.ok, false);
  assert.ok(a.blockers.some((b) => /打标从未执行/.test(b)));
});

test('P1 · RQ-157 测试流量占比可查', () => {
  const a = auditTestIsolation({ scopeCounts: { real: 100, test: 300 } });
  assert.equal(a.scope.testRatio, 75);
  assert.equal(a.scope.real, 100);
});

test('P3 · RQ-157 auditTestIsolation 全空入参不抛错', () => {
  const a = auditTestIsolation();
  assert.ok(Array.isArray(a.blockers));
  assert.equal(typeof a.ok, 'boolean');
});

test('P5 · RQ-157 boardScopeOf 非法值一律回落 real（绝不因拼错参数放测试流量进来）', () => {
  assert.equal(boardScopeOf({ scope: 'ALL' }), 'all');
  assert.equal(boardScopeOf({ scope: 'real' }), 'real');
  assert.equal(boardScopeOf({ scope: 'weird' }), DEFAULT_TRAFFIC_SCOPE);
  assert.equal(boardScopeOf(null), DEFAULT_TRAFFIC_SCOPE);
  assert.equal(boardScopeOf({}), DEFAULT_TRAFFIC_SCOPE);
});

test('P4 · RQ-157 10 万行 resume 去重判定应在 1 秒内完成', () => {
  const rows = [];
  for (let i = 0; i < 100000; i += 1) rows.push({ id: i, subject: `u${i % 50}`, session_id: String(i % 500) });
  const t0 = Date.now();
  const ids = pickDuplicateResumeIds(rows);
  const ms = Date.now() - t0;
  assert.equal(ids.length, 100000 - 500);
  assert.ok(ms < 1000, `耗时 ${ms}ms 超过 1 秒`);
});

test('P4 · RQ-157 200 份源文件扫描应在 2 秒内完成', () => {
  const files = [];
  for (let i = 0; i < 200; i += 1) {
    files.push({ path: `src/services/s${i}.js`, text: `SELECT 1 FROM analytics_events WHERE a=${i}` });
  }
  const t0 = Date.now();
  const r = scanMissingTestFilter(files);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.offenders.length, 200);
  assert.equal(SCOPE_WINDOW_CHARS, 600);
});

test('P3 · RQ-157 collectSourceFiles 读不到目录时返回空数组而非抛错', () => {
  assert.deepEqual(collectSourceFiles({ root: '/x' }), []);
  const out = collectSourceFiles({
    root: '/src',
    dirs: ['services'],
    readFn: () => 'SELECT 1 FROM analytics_events',
    readdirFn: () => ['a.js', 'b.ts', 'c.js'],
    joinFn: (a, b) => `${a}/${b}`,
  });
  assert.equal(out.length, 2, '只收 .js');
  assert.equal(out[0].path, 'src/services/a.js');
  // 目录不存在（readdirFn 抛错）时跳过而不是中断整个扫描
  assert.equal(collectSourceFiles({ root: '/x', dirs: ['services'], readFn: () => 'x', readdirFn: () => { throw new Error('ENOENT'); } }).length, 0);
});

/* ================================================================== *
 * RQ-158 埋点与业务表一致性                                            *
 * ================================================================== */

test('P0 · RQ-158 双向对账：总数相同的反向错误不会被互相抵消', () => {
  const r = reconcileConsistency(
    [{ id: 11, session_id: 999 }, { id: 12, session_id: 1 }],
    [{ session_id: 1 }, { session_id: 2 }]
  );
  assert.equal(r.ok, false);
  assert.equal(r.eventCount, 2);
  assert.equal(r.sessionCount, 2);
  assert.equal(r.diff, 0, '总数看起来一致');
  assert.equal(r.orphanEvents.length, 1, '埋点记了不存在的会话');
  assert.equal(r.missingEvents.length, 1, '会话结算了但没埋点');
  assert.match(r.detail, /event#11/);
  assert.match(r.detail, /session#2/);
});

test('P0 · RQ-158 完全对账一致时 ok，且给出匹配局数', () => {
  const r = reconcileConsistency([{ id: 1, session_id: 5 }, { id: 2, session_id: 6 }], [{ session_id: 5 }, { session_id: 6 }]);
  assert.equal(r.ok, true);
  assert.equal(r.matchedCount, 2);
  assert.match(r.detail, /对账一致/);
});

test('P0 · RQ-158 埋点未携带 sessionId 时归为 orphan，理由可读', () => {
  const r = reconcileConsistency([{ id: 7, session_id: null }], []);
  assert.equal(r.ok, false);
  assert.equal(r.orphanEvents[0].sessionId, null);
  assert.match(r.orphanEvents[0].reason, /未携带 sessionId/);
});

test('P3 · RQ-158 reconcileConsistency 空入参与脏数据不抛错', () => {
  const r = reconcileConsistency(null, null);
  assert.equal(r.ok, true);
  assert.equal(r.eventCount, 0);
  assert.equal(reconcileConsistency([null, {}], [null]).sessionCount, 1);
});

test('P0 · RQ-158 无 queryFn 时降级为 warn 且明确写出「未校验」', async () => {
  const r = await checkTelemetryConsistency({});
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.match(r.detail, /未校验/);
});

test('P0 · RQ-158 注入不一致数据时判定失败并输出差异明细', async () => {
  const q = async (sql) => (sql.includes("'blind_finish'") ? { rows: [{ id: 1, session_id: 999 }] } : { rows: [] });
  const r = await checkTelemetryConsistency({ queryFn: q });
  assert.equal(r.ok, false);
  assert.match(r.detail, /session=999/);
});

test('P3 · RQ-158 queryFn 抛错时判定失败但不向外抛出（发布验证不能自己崩）', async () => {
  const r = await checkTelemetryConsistency({ queryFn: async () => { throw new Error('DB down'); } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /DB down/);
});

test('P0 · RQ-160 连续 2 次不同提交均有验证记录才算达标', () => {
  const rows = [
    { git_commit: 'aaa', ok: true },
    { git_commit: 'bbb', ok: true },
  ];
  const s = verificationStreak(rows);
  assert.equal(s.ok, true);
  assert.equal(s.streak, 2);
  assert.equal(REQUIRED_VERIFY_STREAK, 2);
});

test('P1 · RQ-160 同一提交重复验证只算一次；一次未通过即打断连续', () => {
  assert.equal(verificationStreak([{ git_commit: 'a', ok: true }, { git_commit: 'a', ok: true }]).ok, false);
  assert.equal(verificationStreak([{ git_commit: 'a', ok: false }, { git_commit: 'b', ok: true }]).streak, 0);
  assert.equal(verificationStreak([{ git_commit: 'a', ok: true }]).ok, false);
});

test('P3 · RQ-160 verificationStreak 空入参与缺 git_commit 也能计连续', () => {
  assert.equal(verificationStreak(null).streak, 0);
  assert.equal(verificationStreak([]).ok, false);
  assert.equal(verificationStreak([{ ok: true }, { ok: true }]).streak, 2, '缺 commit 时按序号去重');
});

test('P3 · RQ-160 recordVerification 无 queryFn 时不写库也不抛错', async () => {
  const r = await recordVerification({ report: { ok: true, results: [] } });
  assert.equal(r.recorded, false);
  assert.ok(r.reason);
});

test('P1 · RQ-160 recordVerification 落库内容含失败项计数', async () => {
  let seen = null;
  const q = async (_sql, params) => {
    seen = params;
    return { rows: [{ id: 3, run_at: '2026-11-02T00:00:00Z' }] };
  };
  const r = await recordVerification({
    queryFn: q,
    gitCommit: 'abc',
    baseUrl: 'https://x',
    report: { ok: false, results: [{ name: 'a', ok: true }, { name: 'b', ok: false, detail: 'boom' }] },
  });
  assert.equal(r.recorded, true);
  assert.equal(seen[3], 2, 'total');
  assert.equal(seen[4], 1, 'failed');
  assert.match(seen[5], /boom/);
});

/* ================================================================== *
 * RQ-159 外部真实用户邀请归因                                          *
 * ================================================================== */

test('P0 · RQ-159 邀请码归一化：大小写 / 空格 / 连字符不影响比对', () => {
  assert.equal(normalizeInviteCode(' inv-a1b2 '), 'INVA1B2');
  assert.equal(normalizeInviteCode('INV_A1B2'), 'INVA1B2');
  assert.equal(normalizeInviteCode('INV A1B2'), 'INVA1B2');
});

test('P0 · RQ-159 非法邀请码一律判无效（清洗会产生两个输入指向同一码）', () => {
  for (const bad of ['', '   ', 'INV;DROP', 'inv/../x', 'a'.repeat(41), null, undefined, 123]) {
    assert.equal(normalizeInviteCode(bad), null, `${bad} 不应被接受`);
  }
});

test('P0 · RQ-159 邀请码长度与字符集可控（注入随机源可复现）', () => {
  let i = 0;
  const code = newInviteCode({ rand: () => (i++ % 31) / 31, len: 8 });
  assert.equal(code.length, 8);
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(code.includes('0'), false, '排除易混淆字符 0/O/1/I');
  assert.equal(code.includes('O'), false);
  assert.equal(code.includes('1'), false);
  assert.equal(code.includes('I'), false);
});

test('P0 · RQ-159 批量生成唯一码并带分享链接', () => {
  const p = planInvites({ count: 5, baseUrl: 'https://train.example.com', channel: 'community' });
  assert.equal(p.codes.length, 5);
  assert.equal(new Set(p.codes.map((c) => c.code)).size, 5);
  assert.equal(p.codes[0].url, `https://train.example.com/?invite=${p.codes[0].code}`);
  assert.equal(p.codes[0].channel, 'community');
});

test('P3 · RQ-159 批量数量有硬上限，非法入参收敛为 1', () => {
  assert.equal(planInvites({ count: 999999 }).codes.length, MAX_BATCH);
  assert.equal(planInvites({ count: 0 }).codes.length, 1);
  assert.equal(planInvites({ count: -3 }).codes.length, 1);
  assert.equal(planInvites({ count: 'x' }).codes.length, 1);
  assert.equal(planInvites(null).codes.length, 1);
});

test('P5 · RQ-159 分享链接不含任何身份信息（只归因不泄露）', () => {
  const link = buildInviteLink({ baseUrl: 'https://train.example.com', code: 'INVA1B2' });
  assert.equal(link, 'https://train.example.com/?invite=INVA1B2');
  assert.equal(/user|email|token/i.test(link), false);
  assert.equal(buildInviteLink({ code: 'x' }), '/?invite=X', '无 baseUrl 时给相对路径，不伪造域名');
  assert.equal(buildInviteLink({ baseUrl: 'https://x', code: 'bad;code' }), null);
});

test('P0 · RQ-159 5 名注册 + 2 名有效完成即达成目标', () => {
  const rows = [
    { code: 'A1', registered_user_id: 1, started: 1, decided: 3, effective: 1 },
    { code: 'A2', registered_user_id: 2, started: 1, decided: 2, effective: 1 },
    { code: 'A3', registered_user_id: 3, started: 1, decided: 1, effective: 0 },
    { code: 'A4', registered_user_id: 4, started: 0, decided: 0, effective: 0 },
    { code: 'A5', registered_user_id: 5, started: 0, decided: 0, effective: 0 },
  ];
  const s = summarizeInviteFunnel(rows);
  assert.equal(s.counts.registered, 5);
  assert.equal(s.counts.effective, 2);
  assert.equal(s.met, true);
  assert.equal(s.gap.registered, 0);
});

test('P0 · RQ-159 未达成时给出还差几人，并定位断点在哪一步', () => {
  // 断在「注册 → 开训」：5 人注册，0 人开训
  const rows = [1, 2, 3, 4, 5].map((i) => ({ code: `A${i}`, registered_user_id: i, started: 0, decided: 0, effective: 0 }));
  const s = summarizeInviteFunnel(rows);
  assert.equal(s.met, false);
  assert.equal(s.gap.effective, 2);
  assert.equal(s.dropAt, 'started');
  assert.equal(s.dropoffs.find((d) => d.to === 'started').cliff, true);
  assert.match(s.note, /断点/);
});

test('P1 · RQ-159 逐人输出四步路径（验收要 5 份路径记录）', () => {
  const rows = [
    { code: 'A1', registered_user_id: 1, started: 1, decided: 2, effective: 1 },
    { code: 'A2', registered_user_id: 2, started: 1, decided: 1, effective: 0 },
  ];
  const s = summarizeInviteFunnel(rows);
  assert.equal(s.paths.length, 2);
  assert.deepEqual(s.paths[0].done, ['registered', 'started', 'decided', 'effective']);
  assert.equal(s.paths[0].dropAt, null);
  assert.equal(s.paths[1].dropAt, 'effective');
  assert.equal(s.paths[1].dropLabel, '有效完成（≥1 笔成交且走完）');
});

test('P2 · RQ-159 每一步的转化率与流失绝对数同时给出', () => {
  const rows = [
    { code: 'A1', registered_user_id: 1, started: 1, decided: 1, effective: 1 },
    { code: 'A2', registered_user_id: 2, started: 1, decided: 1, effective: 0 },
    { code: 'A3', registered_user_id: 3, started: 0, decided: 0, effective: 0 },
  ];
  const s = summarizeInviteFunnel(rows);
  const toStart = s.steps.find((x) => x.key === 'started');
  assert.equal(toStart.conversionFromPrev, 66.67, '3 注册 → 2 开训');
  const lost = s.dropoffs.find((d) => d.to === 'started');
  assert.equal(lost.lost, 1);
});

test('P3 · RQ-159 空数据 / 脏行不抛错（空库时看板要能打开）', () => {
  const s = summarizeInviteFunnel(null);
  assert.equal(s.counts.created, 0);
  assert.equal(s.met, false);
  const s2 = summarizeInviteFunnel([null, {}, { code: null }]);
  assert.equal(s2.paths.length, 3);
  assert.equal(s2.counts.registered, 0);
  assert.equal(inviteePath(null).dropAt, 'registered');
});

test('P4 · RQ-159 2 万条邀请行汇总应在 1 秒内完成', () => {
  const rows = [];
  for (let i = 0; i < 20000; i += 1) {
    rows.push({ code: `C${i}`, registered_user_id: i % 3 === 0 ? i + 1 : null, started: i % 3 === 0 ? 1 : 0, decided: 0, effective: 0 });
  }
  const t0 = Date.now();
  const s = summarizeInviteFunnel(rows);
  assert.ok(Date.now() - t0 < 1000, `耗时 ${Date.now() - t0}ms`);
  assert.ok(s.counts.registered > 0);
});

test('P5 · RQ-159 验收目标常量锁（≥5 注册 / ≥2 有效完成）', () => {
  assert.deepEqual(INVITE_GOAL, { registered: 5, effective: 2 });
  assert.deepEqual(INVITE_STEPS.map((s) => s.key), ['registered', 'started', 'decided', 'effective']);
});

/* ================================================================== *
 * RQ-156/160 落地脚本与发布后验证                                      *
 * ================================================================== */

test('P0 · RQ-160 仅认领责任人时 dry-run 不写任何文件', () => {
  let written = 0;
  const r = provisionOwnerOnly({
    owner: 'zyan',
    deadline: '2026-11-16',
    envFile: '.env',
    readmeFile: 'README.md',
    existsFn: () => true,
    readFn: () => 'JWT_SECRET=keep-me\n',
    writeFn: () => { written += 1; },
  });
  assert.equal(written, 0);
  assert.equal(r.mode, 'owner-only');
  assert.equal(r.written.length, 2, '预期将写入 .env 与 README');
  assert.equal(r.blockers.length, 1, '域名仍未配置应作为 blocker 报出');
});

test('P0 · RQ-160 apply 后 .env 与 README 都被写入，且不吞掉既有键', () => {
  const writes = {};
  provisionOwnerOnly({
    owner: 'zyan',
    deadline: '2026-11-16',
    envFile: '.env',
    readmeFile: 'README.md',
    apply: true,
    existsFn: () => true,
    readFn: () => 'JWT_SECRET=keep-me\n',
    writeFn: (p, t) => { writes[p] = t; },
  });
  assert.match(writes['.env'], /JWT_SECRET=keep-me/);
  assert.match(writes['.env'], /PUBLIC_ENTRY_OWNER=zyan/);
  assert.match(writes['.env'], /PUBLIC_ENTRY_DEADLINE=2026-11-16/);
  assert.match(writes['README.md'], /责任人（RQ-160）/);
  assert.match(writes['README.md'], /`zyan`/);
});

test('P1 · RQ-160 域名与责任人可以分开认领（不再绑死成一件做不完的事）', () => {
  const r = runProvision({
    owner: 'zyan',
    deadline: '2026-11-16',
    existsFn: () => true,
    readFn: () => 'JWT_SECRET=keep-me\n',
    writeFn: () => {},
  });
  assert.equal(r.ok, true, '无域名但有责任人时应走 owner-only 分支');
  assert.equal(r.mode, 'owner-only');
  assert.match(r.domainSkipped, /域名/);
});

test('P3 · RQ-156 既无域名也无责任人时明确失败并给出理由', () => {
  const r = runProvision({ existsFn: () => true, readFn: () => '' });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.length > 0);
});

test('P3 · RQ-156 parseArgs 解析各参数，未知参数忽略', () => {
  const a = parseArgs(['--domain=a.example.com', '--owner=zyan', '--deadline=2026-11-16', '--apply', '--json', '--unknown=1']);
  assert.equal(a.domain, 'a.example.com');
  assert.equal(a.owner, 'zyan');
  assert.equal(a.deadline, '2026-11-16');
  assert.equal(a.apply, true);
  assert.equal(a.json, true);
  assert.deepEqual(parseArgs([]), { apply: false, json: false });
});

test('P0 · RQ-158 无 queryFn 时一致性对账降级为 warn 且写明未校验', async () => {
  const r = await checkConsistency({});
  assert.equal(r.name, 'telemetry-consistency');
  assert.equal(r.warn, true);
  assert.match(r.detail, /跳过/);
});

test('P0 · RQ-160 验证留痕：落库失败即判失败', async () => {
  const r = await checkVerificationRecord({ queryFn: null, report: { ok: true, results: [] } });
  assert.equal(r.ok, true, '无 DB 时降级');
  assert.equal(r.warn, true);
  const r2 = await checkVerificationRecord({
    queryFn: async () => { throw new Error('no table'); },
    report: { ok: true, results: [] },
  });
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /no table/);
});

test('P1 · RQ-160 streak 不足时只告警不自锁（否则第一次跑必然失败）', async () => {
  const calls = [];
  const q = async (sql, params) => {
    calls.push(String(sql).slice(0, 30));
    if (String(sql).includes('INSERT INTO release_verifications')) return { rows: [{ id: 9, run_at: 'x' }] };
    return { rows: [{ git_commit: 'aaa', ok: true }] };
  };
  const r = await checkVerificationRecord({ queryFn: q, baseUrl: 'https://x', report: { ok: true, results: [{ name: 'a', ok: true }] }, commit: 'aaa' });
  assert.equal(r.ok, true, '记录已落库即算通过');
  assert.equal(r.warn, true, '连续次数不足应告警');
  assert.equal(r.streak.streak, 1);
  assert.equal(calls.length, 2);
});

test('P3 · RQ-160 gitHead 取不到提交号时返回 null 而非抛错', () => {
  assert.equal(gitHead({ execFn: () => { throw new Error('not a repo'); } }), null);
  assert.equal(gitHead({ execFn: () => 'abc123\n' }), 'abc123');
});

test('P5 · RQ-123 验证清单保留历史端点并纳入 v13 新端点', () => {
  const paths = REQUIRED_ROUTES.map((r) => r.path);
  for (const p of ['/api/public/access', '/api/guest/session', '/api/growth/funnel', '/api/config/public-access', '/api/rooms']) {
    assert.ok(paths.includes(p), `历史端点 ${p} 不得丢失`);
  }
  for (const p of ['/api/analytics/isolation', '/api/invite/funnel', '/api/invite/codes']) {
    assert.ok(paths.includes(p), `v13 端点 ${p} 必须纳入验证`);
  }
  const iso = REQUIRED_ROUTES.find((r) => r.path === '/api/analytics/isolation');
  assert.ok(iso.allow.includes(401), '需登录端点应允许 401');
});

/* ---------------------- 发布前检查里的 RQ-160 ---------------------- */

const okEnv = 'JWT_SECRET=x\nPUBLIC_ENTRY_OWNER=zyan\nPUBLIC_ENTRY_DEADLINE=2026-11-16\n';
const okReadme = '## 公网入口\n| 责任人（RQ-160） | `zyan` |\n';

test('P0 · RQ-160 发布前检查：未指定责任人即阻断', () => {
  const r = checkPublicOwner({ existsFn: () => true, readFn: () => '# README', now: new Date('2026-11-02T00:00:00+08:00') });
  assert.equal(r.ok, false);
  assert.match(r.detail, /PUBLIC_ENTRY_OWNER/);
  assert.ok(r.owner.blocked);
});

test('P0 · RQ-160 发布前检查：owner + 截止日 + README 写明三项齐全才不告警', () => {
  const r = checkPublicOwner({ existsFn: () => true, readFn: () => okReadme, now: new Date('2026-11-02T00:00:00+08:00'), readEnv: okEnv });
  // readFn 被 .env 与 README 共用，这里用 readFn 直接喂 README；再用注入 env 的方式验证正向路径
  assert.equal(typeof r.ok, 'boolean');
  const r2 = checkPublicOwner({
    existsFn: () => true,
    readFn: (p) => (String(p).endsWith('README.md') ? okReadme : okEnv),
    now: new Date('2026-11-02T00:00:00+08:00'),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.warn, false, 'README 已同步时不应告警');
  assert.equal(r2.owner.owner, 'zyan');
});

test('P1 · RQ-160 README 未同步责任人时通过但告警（不同步就会再次失忆）', () => {
  const r = checkPublicOwner({
    existsFn: () => true,
    readFn: (p) => (String(p).endsWith('README.md') ? '# 无责任人章节' : okEnv),
    now: new Date('2026-11-02T00:00:00+08:00'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.match(r.detail, /README 未写明责任人/);
});

test('P3 · RQ-160 责任人在 backend/.env 而非仓库根时同样能读到（此前只读一处）', () => {
  const r = checkPublicOwner({
    existsFn: (p) => String(p).endsWith('backend\\.env') || String(p).endsWith('backend/.env'),
    readFn: () => okEnv,
    now: new Date('2026-11-02T00:00:00+08:00'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.owner.owner, 'zyan');
});

test('P3 · RQ-160 三个文件全不存在时返回结构化结果而非抛错', () => {
  const r = checkPublicOwner({ existsFn: () => false, readFn: () => '', now: new Date('2026-11-02T00:00:00+08:00') });
  assert.equal(r.ok, false);
  assert.match(r.detail, /未找到/);
  assert.equal(typeof r.owner.state, 'string');
});

test('P0 · RQ-158/160 runVerify 在无外部环境下仍返回 8 项结果且不抛出', async () => {
  const report = await runVerify({
    queryFn: null,
    fetchFn: async () => ({ status: 200, text: async () => '' }),
    indexHtml: null,
    existsFn: () => false,
    listFn: () => [],
  });
  assert.equal(report.results.length, 8, 'v13 的两项必须真的出现在结果里');
  const names = report.results.map((r) => r.name);
  assert.ok(names.includes('telemetry-consistency'));
  assert.ok(names.includes('verification-record'));
  for (const r of report.results) {
    assert.ok(r.name && r.detail, `${r.name} 必须有名称与说明`);
    assert.equal(typeof r.ok, 'boolean');
  }
});
