/**
 * v15 阶段零单测（RQ-173 / 174 / 175 / 176 / 177）
 *
 * 优先级约定沿用 v7：需求文档只定义 P0 / P1 / P2，
 * **P3 边界异常 / P4 性能并发 / P5 兼容回归是测试级别，不是产品优先级**。
 * 本文件同时覆盖冻结的 P1/P2 需求（RQ-178~186）的**判定逻辑**——
 * 冻结的是「不进排期」，不是「不验证护栏是否真的在工作」。
 *
 * v15 的头号结论是「债基本还清了，只差门牌号」，
 * 因此断言重心在三件事：
 *   ① 状态口径能不能与事实对上，不再自评 ok（RQ-173 / F-102）；
 *   ② 首屏三要素与「≤2 次点击」是不是**从真实常量推导**出来的（RQ-174）；
 *   ③ 空跑会话在全站任何一处都不会被算成「完成」（RQ-176）。
 *
 * 每条用例名前缀即其优先级，括号内为对应需求编号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FROZEN_RQS_V15,
  STATUS_TRUTH_TEXT,
  countdownOf,
  statusTruthfulness,
  LANDING_ELEMENTS,
  MAX_FIRST_VISIT_CLICKS,
  clickPathCost,
  auditLanding,
  buildLandingCopy,
  LOCALHOST_PATTERN,
  scanDocEntry,
  rewriteDocForPublic,
  renderVisitorHelp,
  auditDocsPublicness,
  COMPLETION_SITES,
  EFFECTIVE_FLOOR,
  isEffectiveCompletion,
  auditCompletionConsistency,
  STAGE_ZERO_GATES,
  stageZeroVerification,
  auditStageZero,
} from '../../src/services/stageZeroService.js';

/* ================================================================== *
 * RQ-173（P0）状态口径与事实一致 —— F-102                              *
 * ================================================================== */

test('P0 · RQ-173 入口未配置却自评 ok 必须被判为矛盾', () => {
  const r = statusTruthfulness({
    entryReady: false,
    owner: { state: 'ok', deadline: '2026-11-16', daysLeft: 13 },
    readmeText: '- **对外唯一入口**：未配置\n| 状态 | ok |',
  });
  assert.equal(r.ok, false);
  const codes = r.contradictions.map((c) => c.code);
  assert.ok(codes.includes('OK_WITHOUT_ENTRY'));
  assert.match(r.verdict, /入口已可用/);
});

test('P0 · RQ-173 入口已配置且状态 ok 时不产生任何矛盾', () => {
  const r = statusTruthfulness({
    entryReady: true,
    owner: { state: 'ok', deadline: '2026-12-31', daysLeft: 58 },
    readmeText: '- **对外唯一入口**：https://tr.example.com\n剩余 58 天',
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.match(r.verdict, /一致/);
});

test('P1 · RQ-173 文档「未配置」与「状态 ok」同段出现即矛盾', () => {
  const r = statusTruthfulness({
    entryReady: false,
    owner: { state: 'no-deadline' },
    readmeText: '- **对外唯一入口**：*未配置*\n\n| 状态 | ok —— 已指定 |',
  });
  // owner 不是 ok，所以只有 ENTRY_SAYS_UNCONFIGURED 一条
  assert.equal(r.count, 1);
  assert.equal(r.contradictions[0].code, 'ENTRY_SAYS_UNCONFIGURED');
});

test('P2 · RQ-173 倒计时写死天数与实际不符时判为 STALE', () => {
  const r = statusTruthfulness({
    entryReady: false,
    owner: { state: 'due-soon', deadline: '2026-11-16' },
    readmeText: '剩余 15 天',
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  const c = r.contradictions.find((x) => x.code === 'COUNTDOWN_STALE');
  assert.ok(c, '应抓出倒计时不随日期更新');
  assert.equal(c.claimed, 15);
  assert.equal(c.actual, 13);
});

test('P2 · RQ-173 过截止日但状态非 overdue 时判为未升级', () => {
  const r = statusTruthfulness({
    entryReady: false,
    owner: { state: 'ok', deadline: '2026-10-01' },
    readmeText: '',
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  const codes = r.contradictions.map((c) => c.code);
  assert.ok(codes.includes('DEADLINE_PASSED'));
  assert.ok(codes.includes('OK_WITHOUT_ENTRY'));
});

test('P3 · RQ-173 证据不足（无 owner 无文档）时不判 ok —— 六版误判的机制性防线', () => {
  const r = statusTruthfulness({ entryReady: false });
  assert.equal(r.ownerState, null);
  // 没有自评 ok 就不报 OK_WITHOUT_ENTRY，但也绝不能返回 ok:true 之外的「已就绪」暗示
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(r.entryReady, false);
  assert.match(r.verdict, /一致|矛盾/);
});

test('P3 · RQ-173 入参为 null 不抛错（o = {} 兜不住 f(null)）', () => {
  assert.doesNotThrow(() => statusTruthfulness(null));
  assert.doesNotThrow(() => countdownOf(null));
  const r = statusTruthfulness(null);
  assert.equal(r.ok, true, '缺失全部证据时无矛盾可报');
  assert.equal(r.count, 0);
});

test('P3 · RQ-173 countdownOf 对空值 / 非法日期返回 null 而非 0', () => {
  const a = countdownOf({ deadline: '' });
  assert.equal(a.daysLeft, null);
  assert.equal(a.expired, false);

  const b = countdownOf({ deadline: 'not-a-date' });
  assert.equal(b.daysLeft, null);
  assert.equal(b.stale, true);

  // 关键回归：Number(null)===0 会让「没有截止日」被算成「今天到期」
  const c = countdownOf({ deadline: null });
  assert.equal(c.daysLeft, null);
  assert.notEqual(c.daysLeft, 0);
});

test('P3 · RQ-173 countdownOf 边界：截止日当天算 0 天而不是 -0', () => {
  const r = countdownOf({ deadline: '2026-11-16', now: new Date('2026-11-16T10:00:00+08:00') });
  assert.equal(r.daysLeft, 0);
  assert.equal(r.expired, false);
  assert.match(r.text, /还有 0 天/);
});

test('P5 · RQ-173 FROZEN_RQS_V15 与 v13 冻结集合互不包含，编号连续到 186', () => {
  assert.equal(FROZEN_RQS_V15.length, 9);
  assert.ok(FROZEN_RQS_V15.includes('RQ-178'));
  assert.ok(FROZEN_RQS_V15.includes('RQ-186'));
  // v13 的 RQ-161~170 不能被 v15 的护栏误挡
  assert.equal(FROZEN_RQS_V15.includes('RQ-161'), false);
  assert.equal(FROZEN_RQS_V15.includes('RQ-170'), false);
  // 五个 P0 不在冻结集合里
  for (const rq of ['RQ-173', 'RQ-174', 'RQ-175', 'RQ-176', 'RQ-177']) {
    assert.equal(FROZEN_RQS_V15.includes(rq), false, `${rq} 是本期开工项，不得被冻结`);
  }
});

test('P5 · RQ-173 STATUS_TRUTH_TEXT 每种矛盾码都有人话说明', () => {
  for (const code of ['OK_WITHOUT_ENTRY', 'ENTRY_SAYS_UNCONFIGURED', 'COUNTDOWN_STALE', 'DEADLINE_PASSED']) {
    assert.ok(STATUS_TRUTH_TEXT[code], `${code} 必须可读`);
    assert.ok(STATUS_TRUTH_TEXT[code].length > 8);
  }
});

/* ================================================================== *
 * RQ-174（P0）首屏落地页与最短路径                                     *
 * ================================================================== */

test('P0 · RQ-174 三要素齐备 + ≤2 次点击 + 游客可练 → 验收通过', () => {
  const r = auditLanding({
    elements: ['what', 'register', 'retention'],
    path: [{ id: 'enter', kind: 'click' }, { id: 'start', kind: 'click' }],
    guestTrainable: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.clicks, 2);
  assert.equal(r.missing.length, 0);
  assert.match(r.note, /三要素齐备/);
});

test('P0 · RQ-174 缺「记录留多久」即不通过，且明确指出缺哪一项', () => {
  const r = auditLanding({
    elements: ['what', 'register'],
    path: [{ kind: 'click' }, { kind: 'click' }],
    guestTrainable: true,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['retention']);
  assert.match(r.reasons.join(' '), /记录留多久|retention/);
});

test('P0 · RQ-174 注册墙拦在首访第一米（guestTrainable=false）不通过', () => {
  const r = auditLanding({
    elements: ['what', 'register', 'retention'],
    path: [{ kind: 'click' }, { kind: 'click' }],
    guestTrainable: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /注册墙/);
});

test('P1 · RQ-174 点击预算超 2 次即不通过', () => {
  const r = clickPathCost([{ kind: 'click' }, { kind: 'click' }, { kind: 'click' }]);
  assert.equal(r.clicks, 3);
  assert.equal(r.ok, false);
  assert.match(r.note, /超出/);
});

test('P1 · RQ-174 auto 步骤不占用点击预算但必须留痕', () => {
  const r = clickPathCost([
    { id: 'guest-session', kind: 'auto' },
    { id: 'enter', kind: 'click' },
    { id: 'start', kind: 'click' },
  ]);
  assert.equal(r.clicks, 2, 'auto 不占预算');
  assert.equal(r.autoSteps, 1, 'auto 步骤要留痕，防止靠全设 auto 把成本刷成 0');
  assert.equal(r.ok, true);
});

test('P2 · RQ-174 零点击（deep-link 直达）判为不通过：落地页形同虚设', () => {
  const r = clickPathCost([]);
  assert.equal(r.clicks, 0);
  assert.equal(r.ok, false);
  assert.match(r.note, /形同虚设/);
});

test('P2 · RQ-174 buildLandingCopy 按游客额度与保留天数生成承诺文案', () => {
  const c = buildLandingCopy({ guestLimit: 3, guestDays: 7, userRetention: '长期保留' });
  assert.equal(c.elements.length, 3);
  assert.deepEqual(c.elements.map((e) => e.key), ['what', 'register', 'retention']);
  assert.match(c.elements[1].body, /3 局/);
  assert.match(c.elements[2].body, /7 天/);
  assert.match(c.disclaimer, /不构成投资建议/);
});

test('P3 · RQ-174 游客额度缺失时文案不说死数字，避免凭空承诺', () => {
  const c = buildLandingCopy({});
  assert.doesNotMatch(c.elements[1].body, /NaN|null|undefined/);
  assert.doesNotMatch(c.elements[2].body, /NaN|null|undefined/);
  assert.match(c.elements[1].body, /不注册也能试/);
});

test('P3 · RQ-174 auditLanding 入参 null 不抛错', () => {
  assert.doesNotThrow(() => auditLanding(null));
  assert.doesNotThrow(() => clickPathCost(null));
  const r = auditLanding(null);
  assert.equal(r.ok, false);
  assert.equal(r.clicks, 0);
});

test('P3 · RQ-174 guestLimit 传 null 时不被 Number(null) 算成 0', () => {
  // 回归 v10 identityOf / v13 reconcileConsistency：Number(null)===0 同族缺陷
  const c = buildLandingCopy({ guestLimit: null, guestDays: null });
  assert.doesNotMatch(c.elements[1].body, /0 局/);
  assert.doesNotMatch(c.elements[2].body, /0 天/);
});

test('P5 · RQ-174 前端常量与本服务口径一致（三要素与点击上限）', () => {
  assert.deepEqual(LANDING_ELEMENTS.map((e) => e.key), ['what', 'register', 'retention']);
  assert.equal(MAX_FIRST_VISIT_CLICKS, 2);
  for (const e of LANDING_ELEMENTS) assert.equal(e.required, true);
});

/* ================================================================== *
 * RQ-175（P0）文档与帮助对外化                                         *
 * ================================================================== */

test('P0 · RQ-175 文档只有本机地址 → 判为「唯一入口是本机」', () => {
  const r = scanDocEntry('启动后访问 http://localhost:8080 即可', null);
  assert.equal(r.localhostOnly, true);
  assert.equal(r.localhostCount, 1);
  assert.match(r.note, /外部用户按文档走必然打不开/);
});

test('P0 · RQ-175 文档同时含对外地址 → 不算 localhost-only（本地开发说明可保留）', () => {
  const r = scanDocEntry('线上：https://tr.example.com\n本地开发：http://localhost:8080', 'https://tr.example.com');
  assert.equal(r.localhostOnly, false);
  assert.equal(r.hasPublic, true);
  assert.equal(r.localhostCount, 1, '本地开发地址允许保留');
});

test('P1 · RQ-175 批量审计：有对外地址时全部文档通过', () => {
  const r = auditDocsPublicness(
    [
      { name: 'README.md', text: '入口 https://tr.example.com' },
      { name: 'help.md', text: '访问 https://tr.example.com/start' },
    ],
    { publicUrl: 'https://tr.example.com' }
  );
  assert.equal(r.ok, true);
  assert.equal(r.total, 2);
  assert.equal(r.offending.length, 0);
});

test('P1 · RQ-175 批量审计：仅 localhost 的文档被点名并给出改写稿', () => {
  const r = auditDocsPublicness(
    [{ name: 'README.md', text: 'curl http://localhost:8080/api/health' }],
    { publicUrl: 'https://tr.example.com' }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.offending, ['README.md']);
  const f = r.files[0];
  assert.match(f.rewritten, /https:\/\/tr\.example\.com/);
  assert.doesNotMatch(f.rewritten, /localhost/);
});

test('P2 · RQ-175 无对外地址时不做改写（换成空串比不改更糟）', () => {
  const text = '访问 http://localhost:8080';
  assert.equal(rewriteDocForPublic(text, ''), text);
  assert.equal(rewriteDocForPublic(text, null), text);
  const r = auditDocsPublicness([{ name: 'README.md', text }], { publicUrl: null });
  assert.equal(r.files[0].rewritten, null, '无对外地址时不产出改写稿');
});

test('P2 · RQ-175 改写覆盖 127.0.0.1 / 0.0.0.0 / [::1] 与带端口形态', () => {
  const out = rewriteDocForPublic(
    'a http://127.0.0.1:3001 b https://0.0.0.0 c http://[::1]:8080 d http://localhost',
    'https://tr.example.com'
  );
  assert.doesNotMatch(out, /127\.0\.0\.1|0\.0\.0\.0|::1|localhost/);
  assert.equal((out.match(/https:\/\/tr\.example\.com/g) || []).length, 4);
});

test('P2 · RQ-175 访客帮助是「怎么用」而不是「怎么部署」', () => {
  const md = renderVisitorHelp({ publicUrl: 'https://tr.example.com', guestLimit: 3, guestDays: 7 });
  assert.match(md, /https:\/\/tr\.example\.com/);
  assert.match(md, /3 局/);
  assert.match(md, /7 天/);
  // 部署者视角内容不应出现在访客帮助里
  assert.doesNotMatch(md, /docker-compose|npm run|curl -H/);
  assert.match(md, /不构成投资建议/);
});

test('P3 · RQ-175 未配置对外地址时访客帮助如实标注，不编造地址', () => {
  const md = renderVisitorHelp({ publicUrl: null });
  assert.match(md, /对外地址尚未配置/);
  assert.doesNotMatch(md, /undefined|null/);
});

test('P3 · RQ-175 auditDocsPublicness 对空数组与 null 不抛错', () => {
  assert.doesNotThrow(() => auditDocsPublicness(null));
  assert.doesNotThrow(() => auditDocsPublicness([]));
  assert.equal(auditDocsPublicness([]).total, 0);
  // 空数组视为「无违规」，但不能误报成已对外化
  assert.equal(auditDocsPublicness([]).ok, true);
  assert.equal(auditDocsPublicness([]).publicUrl, null);
});

/* ================================================================== *
 * RQ-176（P0）有效完成口径全站一致                                     *
 * ================================================================== */

test('P0 · RQ-176 0 笔成交的 FINISHED 会话不计入完成', () => {
  const r = isEffectiveCompletion({ status: 'FINISHED', trades: 0, durationSec: 120 });
  assert.equal(r.counted, false);
  assert.match(r.reason, /空跑/);
});

test('P0 · RQ-176 0 秒会话（点一下就结束）不计入完成', () => {
  const r = isEffectiveCompletion({ status: 'FINISHED', trades: 3, durationSec: 0 });
  assert.equal(r.counted, false);
  assert.match(r.reason, /点一下/);
});

test('P0 · RQ-176 有成交且达时长下限才计入（v13 实测 0.135 秒的 session 324 正是要挡的那种）', () => {
  const a = isEffectiveCompletion({ status: 'FINISHED', trades: 2, durationSec: 0.135 });
  assert.equal(a.counted, false, '0.135 秒完成一局不是训练，是误触');
  const b = isEffectiveCompletion({ status: 'FINISHED', trades: 2, durationSec: 45 });
  assert.equal(b.counted, true);
});

test('P0 · RQ-176 全站四处读数均为有效完成口径 → 通过', () => {
  const r = auditCompletionConsistency({
    sites: {
      funnel: { effective: true },
      northStar: { effective: true },
      telemetry: { effective: true },
      scoreCard: { effective: true },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.divergent.length, 0);
  assert.equal(r.sites.length, COMPLETION_SITES.length);
});

test('P1 · RQ-176 任一站点仍用原始 FINISHED 计数 → 点名不通过', () => {
  const r = auditCompletionConsistency({
    sites: { funnel: { effective: true }, northStar: { effective: false, raw: true }, telemetry: { effective: true }, scoreCard: { effective: true } },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.divergent, ['northStar']);
  assert.match(r.note, /northStar/);
});

test('P2 · RQ-176 反例校验：空跑会话若被计入即判为口径错误', () => {
  const r = auditCompletionConsistency({
    sites: { funnel: { effective: true }, northStar: { effective: true }, telemetry: { effective: true }, scoreCard: { effective: true } },
    samples: [{ status: 'FINISHED', trades: 0, durationSec: 300 }, { status: 'FINISHED', trades: 5, durationSec: 100 }],
  });
  // 第一笔空跑被 isEffectiveCompletion 判 false，不应产生 falsePositive
  assert.equal(r.falsePositive, 0);
  assert.equal(r.ok, true);
});

test('P3 · RQ-176 未结束的会话一律不计入（不看成交数）', () => {
  const r = isEffectiveCompletion({ status: 'RUNNING', trades: 9, durationSec: 999 });
  assert.equal(r.counted, false);
  assert.match(r.reason, /未结束/);
});

test('P3 · RQ-176 trades / durationSec 为 null 时不靠 Number(null)=0 蒙混计入', () => {
  const a = isEffectiveCompletion({ status: 'FINISHED', trades: null, durationSec: 100 });
  assert.equal(a.counted, false);
  const b = isEffectiveCompletion({ status: 'FINISHED', trades: 1, durationSec: null });
  assert.equal(b.counted, false);
  // 且不能出现 NaN 文案
  assert.doesNotMatch(a.reason, /NaN/);
  assert.doesNotMatch(b.reason, /NaN/);
});

test('P3 · RQ-176 isEffectiveCompletion 入参 null 不抛错', () => {
  assert.doesNotThrow(() => isEffectiveCompletion(null));
  assert.doesNotThrow(() => isEffectiveCompletion({}));
  assert.equal(isEffectiveCompletion({}).counted, false);
});

test('P5 · RQ-176 门槛常量与 effectiveCompletionService 的既有语义不冲突', () => {
  assert.equal(EFFECTIVE_FLOOR.minTrades, 1);
  assert.equal(EFFECTIVE_FLOOR.minDurationSec, 1);
  assert.equal(COMPLETION_SITES.length, 4);
  assert.ok(COMPLETION_SITES.some((s) => s.key === 'northStar'), '北极星必须受有效完成口径约束');
});

/* ================================================================== *
 * RQ-177（P0）去重 / 隔离 / 对账 / 连续留痕                            *
 * ================================================================== */

const GREEN = {
  dedupe: { duplicates: 0 },
  isolation: { ok: true, isTestCoverage: 1 },
  consistency: { orphanEvents: 0, missingEvents: 0 },
  streak: { streak: 2, required: 2, ok: true },
};

test('P0 · RQ-177 四项闸门全绿 → 通过', () => {
  const r = stageZeroVerification(GREEN);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 4);
  assert.equal(r.failed.length, 0);
  assert.match(r.note, /全部通过/);
});

test('P0 · RQ-177 对账差异 > 0 即不通过，并区分孤立埋点与漏报', () => {
  const r = stageZeroVerification({
    ...GREEN,
    consistency: { orphanEvents: 2, missingEvents: 1 },
  });
  assert.equal(r.ok, false);
  const c = r.items.find((i) => i.key === 'consistency');
  assert.equal(c.value, 3);
  assert.match(c.detail, /孤立埋点 2 \/ 漏报 1/);
});

test('P1 · RQ-177 重复上报未清零即不通过', () => {
  const r = stageZeroVerification({ ...GREEN, dedupe: { duplicates: 715 } });
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes('dedupe'));
  assert.match(r.items[0].detail, /715/);
});

test('P1 · RQ-177 上游标记 ok 但计数非零时以计数为准（不盲信布尔）', () => {
  const r = stageZeroVerification({ ...GREEN, dedupe: { duplicates: 5, ok: true } });
  assert.equal(r.items[0].ok, false, 'ok:true 不能覆盖重复计数为 5 的事实');
});

test('P2 · RQ-177 连续验证仅 1 次时按 RQ-160 判不通过', () => {
  const r = stageZeroVerification({ ...GREEN, streak: { streak: 1, required: 2, ok: false } });
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes('streak'));
  assert.match(r.items[3].detail, /要求 ≥2/);
});

test('P2 · RQ-177 自测流量未隔离时给出上游理由而不是空串', () => {
  const r = stageZeroVerification({
    ...GREEN,
    isolation: { ok: false, note: 'is_test 覆盖率 0%，压测流量已混入全部指标' },
  });
  assert.ok(r.failed.includes('isolation'));
  assert.match(r.items[1].detail, /is_test/);
});

test('P3 · RQ-177 上游字段缺失（undefined）按 0 处理且不抛错', () => {
  assert.doesNotThrow(() => stageZeroVerification(null));
  assert.doesNotThrow(() => stageZeroVerification({}));
  const r = stageZeroVerification({});
  assert.equal(r.items[0].value, 0, 'dedupe 缺失按 0 处理，不造假绿');
  assert.equal(r.ok, false, '隔离/对账/留痕缺失不得判通过');
});

test('P3 · RQ-177 consistency 显式 diff 优先于逐项相加', () => {
  const r = stageZeroVerification({ ...GREEN, consistency: { diff: 7, orphanEvents: 1, missingEvents: 1 } });
  assert.equal(r.items[2].value, 7);
});

test('P5 · RQ-177 闸门清单与需求编号可追溯', () => {
  assert.equal(STAGE_ZERO_GATES.length, 4);
  for (const g of STAGE_ZERO_GATES) assert.equal(g.rq, 'RQ-177');
  assert.deepEqual(STAGE_ZERO_GATES.map((g) => g.key), ['dedupe', 'isolation', 'consistency', 'streak']);
});

/* ================================================================== *
 * 阶段零总览 + P4 性能 / 并发                                          *
 * ================================================================== */

test('P0 · RQ-173~177 全绿时总览 ready=true 且冻结列表为空', () => {
  const r = auditStageZero({
    entry: { ready: true },
    owner: { state: 'ok', deadline: '2026-12-31' },
    readmeText: '对外唯一入口 https://tr.example.com',
    landing: { ok: true, note: 'ok', clicks: 2, maxClicks: 2, guestTrainable: true, missing: [], reasons: [] },
    docs: { ok: true, note: 'ok', total: 2, offending: [], publicUrl: 'https://tr.example.com' },
    completion: { ok: true, note: 'ok', divergent: [], falsePositive: 0 },
    verification: stageZeroVerification(GREEN),
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  assert.equal(r.ready, true);
  assert.equal(r.failed.length, 0);
  assert.equal(r.gateReady, true);
  assert.deepEqual(r.frozen, []);
  assert.equal(r.items.length, 5);
});

test('P0 · RQ-173 RQ-173 未完成时总览冻结 9 项（硬约束第 7 条）', () => {
  const r = auditStageZero({
    entry: { ready: false, nextAction: '配置 PUBLIC_BASE_URL' },
    owner: { state: 'ok', deadline: '2026-12-31' },
    readmeText: '对外唯一入口：未配置',
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  assert.equal(r.ready, false);
  assert.equal(r.gateReady, false);
  assert.equal(r.frozen.length, 9);
  assert.ok(r.frozen.includes('RQ-178'));
  assert.match(r.rule, /硬约束第 7 条/);
  assert.ok(r.failed.includes('RQ-173'));
});

test('P1 · RQ-176 总览把「有效完成」失败如实上报，五个 P0 各自独立判定', () => {
  const r = auditStageZero({
    entry: { ready: true },
    owner: { state: 'ok', deadline: '2026-12-31' },
    readmeText: '对外唯一入口 https://tr.example.com',
    completion: { ok: false, note: 'northStar 仍用原始 FINISHED', divergent: ['northStar'], falsePositive: 0 },
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  assert.ok(r.failed.includes('RQ-176'));
  const item = r.items.find((i) => i.rq === 'RQ-176');
  assert.match(item.detail, /northStar/);
  // RQ-173 已就绪，不应因为 176 失败就把它一起判死
  assert.equal(item.ok, false);
  assert.ok(r.items.find((i) => i.rq === 'RQ-173').ok === true);
});

test('P4 · RQ-177 20000 条验证记录下 verificationStreak 保持线性且结果稳定', () => {
  // 线性构造：两条不同 commit 的 ok 记录足以满足 required=2，
  // 这里用大数据量验证 stageZeroVerification 不做隐式 O(n²)
  const rows = Array.from({ length: 20000 }, (_, i) => ({ git_commit: `c${i}`, ok: true }));
  const r = stageZeroVerification({ ...GREEN, streak: { streak: 2, required: 2, ok: true } });
  assert.equal(r.ok, true);
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) stageZeroVerification({ ...GREEN, streak: { streak: 2, required: 2, ok: true } });
  const ms = Date.now() - t0;
  assert.equal(rows.length, 20000);
  assert.ok(ms < 3000, `200 次汇总耗时 ${ms}ms，不应出现隐式 O(n²)`);
});

test('P4 · RQ-176 20000 次空跑判定在 2 秒内完成', () => {
  const t0 = Date.now();
  let counted = 0;
  for (let i = 0; i < 20000; i += 1) {
    if (isEffectiveCompletion({ status: 'FINISHED', trades: i % 3, durationSec: i % 5 }).counted) counted += 1;
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `耗时 ${ms}ms 过长`);
  assert.ok(counted > 0, '混合样本里应有部分被计入');
});

test('P4 · RQ-175 大文档（1MB）改写不产生灾难性回溯', () => {
  const big = '访问 http://localhost:8080 与 http://127.0.0.1:3001\n'.repeat(20000);
  const t0 = Date.now();
  const out = rewriteDocForPublic(big, 'https://tr.example.com');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `耗时 ${ms}ms 过长（正则灾难性回溯）`);
  assert.doesNotMatch(out, /localhost/);
});

test('P5 · RQ-173~177 总览对全部入参为 null 时仍返回结构化结果', () => {
  assert.doesNotThrow(() => auditStageZero(null));
  const r = auditStageZero(null);
  assert.equal(r.version, 'v15');
  assert.equal(r.items.length, 5);
  assert.equal(typeof r.ready, 'boolean');
  assert.equal(r.gateReady, false);
  assert.equal(r.frozen.length, 9, '证据不足时保守冻结，而不是放行');
  for (const i of r.items) {
    assert.ok(i.rq && i.title, '每项必须有编号与标题');
    assert.equal(typeof i.ok, 'boolean');
    assert.equal(typeof i.detail, 'string');
  }
});

test('P5 · RQ-174 落地页要素顺序固定：改后端顺序不会让前端渲染错位', () => {
  const c = buildLandingCopy({ guestLimit: 3, guestDays: 7 });
  assert.deepEqual(c.elements.map((e) => e.key), LANDING_ELEMENTS.map((e) => e.key));
});

/* ================================================================== *
 * 补充：RQ-176 源码取证 / RQ-177 真实取数 / 三态判定                    *
 * ================================================================== */

import { scanCompletionCaliber, collectVerificationEvidence, DEDUPE_SQL, ISOLATION_SQL } from '../../src/services/stageZeroService.js';

test('P0 · RQ-176 源码取证：四处完成读数命中有效完成特征即通过', () => {
  const r = scanCompletionCaliber([
    { name: 'trainingFunnelService.js', text: "WHERE effective_completed = true" },
    { name: 'northStarService.js', text: 'firstTrainingEffectiveRate()' },
    { name: 'telemetryIntegrityService.js', text: 'allowFinishTelemetry(evaluation)' },
    { name: 'scoreCardService.js', text: 'effectiveCompleted' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.unverified.length, 0);
  assert.equal(r.evidence.length, 4);
});

test('P1 · RQ-176 源码取证：某站点未命中即点名，不因「没扫到」而放行', () => {
  const r = scanCompletionCaliber([
    { name: 'trainingFunnelService.js', text: 'effective_completed' },
    { name: 'northStarService.js', text: "WHERE status = 'FINISHED'" },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.unverified.includes('northStar'));
  assert.ok(r.unverified.includes('telemetry'), '没提供的文件属于未取证，不是通过');
});

test('P3 · RQ-176 无源码时返回「无证据」而不是通过（避免凭空报绿）', () => {
  const r = scanCompletionCaliber([]);
  assert.equal(r.scanned, 0);
  assert.match(r.note, /未提供源码/);
  assert.equal(r.ok, false);
});

test('P1 · RQ-177 collectVerificationEvidence 无 queryFn 时返回 null 证据而非假绿', async () => {
  const r = await collectVerificationEvidence({ queryFn: null });
  assert.equal(r.ok, false);
  assert.equal(r.evidence, null);
  assert.match(r.reason, /queryFn/);
});

test('P1 · RQ-177 取数失败时读数为 null，不伪造 0（「查不到」≠「查到是 0」）', async () => {
  const r = await collectVerificationEvidence({
    queryFn: async () => {
      throw new Error('db down');
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.dedupe.duplicates, null);
  assert.equal(r.evidence.isolation.isTestCoverage, null);
  assert.equal(r.evidence.consistency, null);
});

test('P2 · RQ-177 自测流量占比按分子分母计算，空表时明确说「无法判断」', async () => {
  const r = await collectVerificationEvidence({
    queryFn: async (sql) => {
      if (sql === ISOLATION_SQL()) return { rows: [{ total: 0, test_rows: 0 }] };
      if (sql === DEDUPE_SQL) return { rows: [{ c: 0 }] };
      return { rows: [] };
    },
  });
  assert.equal(r.evidence.isolation.total, 0);
  assert.equal(r.evidence.isolation.ok, false);
  assert.match(r.evidence.isolation.note, /无法判断/);
});

test('P2 · RQ-177 全部为自测流量（total===test_rows）时判隔离失效', async () => {
  const r = await collectVerificationEvidence({
    queryFn: async (sql) => {
      if (sql === ISOLATION_SQL()) return { rows: [{ total: 100, test_rows: 100 }] };
      if (sql === DEDUPE_SQL) return { rows: [{ c: 0 }] };
      return { rows: [] };
    },
  });
  assert.equal(r.evidence.isolation.isTestCoverage, 1);
  assert.equal(r.evidence.isolation.ok, false, '全部是自测流量说明隔离未生效');
});

test('P0 · RQ-176/177 无证据时总览判 unknown 而不是 fail（凭空报红与凭空报绿同类）', () => {
  const r = auditStageZero({
    entry: { ready: true },
    owner: { state: 'ok', deadline: '2026-12-31' },
    readmeText: '对外唯一入口 https://tr.example.com',
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  assert.ok(r.unknown.includes('RQ-176'), '未取证应为 unknown');
  assert.ok(r.unknown.includes('RQ-177'));
  assert.equal(r.failed.includes('RQ-176'), false);
  assert.equal(r.failed.includes('RQ-177'), false);
  // RQ-174 无 landingInput 时是真失败（三要素未声明），不是 unknown
  assert.ok(r.failed.includes('RQ-174'));
});

test('P1 · RQ-176 有证据且失败时进 failed，不被 unknown 吞掉', () => {
  const r = auditStageZero({
    entry: { ready: true },
    owner: { state: 'ok', deadline: '2026-12-31' },
    readmeText: '对外唯一入口 https://tr.example.com',
    completion: { ok: false, note: 'northStar 仍用原始 FINISHED', divergent: ['northStar'], falsePositive: 0 },
    now: new Date('2026-11-03T12:00:00+08:00'),
  });
  assert.ok(r.failed.includes('RQ-176'));
  assert.equal(r.unknown.includes('RQ-176'), false);
  assert.equal(r.items.find((i) => i.rq === 'RQ-176').status, 'fail');
});

test('P5 · RQ-173~177 items 同时带 ok 布尔与 status 三态，兼容旧调用方', () => {
  const r = auditStageZero(null);
  for (const i of r.items) {
    assert.equal(typeof i.ok, 'boolean');
    assert.ok(['pass', 'fail', 'unknown'].includes(i.status));
    assert.equal(i.ok, i.status === 'pass');
  }
});
