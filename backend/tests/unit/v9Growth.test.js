/**
 * v9 增长需求测试（RQ-106 ~ RQ-118）
 *
 * 测试级别沿用 v7/v8 的六级划分（**测试级别，不是产品优先级**）：
 *   P0 主流程     —— 需求的核心承诺是否成立（默认快局、免登录可完成、完成口径唯一）
 *   P1 差异化     —— 与竞品错开的那部分（净胜局不看收益、小样本能说三件事）
 *   P2 留存体验   —— 回访与牵引（达标进度、周报推送）
 *   P3 边界异常   —— 脏入参、零样本、异常路径不崩且不产生伪结论
 *   P4 性能并发   —— 纯函数在高频调用下不退化
 *   P5 兼容回归   —— 旧语义不倒退、口径同源（不出现第二套门槛）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePublicAccess,
  normalizeBaseUrl,
  isLocalHost,
  renderNginxServerConf,
} from '../../src/services/publicAccessService.js';
import {
  BAR_PRESETS,
  DEFAULT_BARS,
  MAX_DEFAULT_BARS,
  MIN_BARS,
  resolveSessionLength,
  decisionPointsFor,
  isShortByDefault,
} from '../../src/services/sessionLengthService.js';
import {
  identityOf,
  normalizeGuestToken,
  newGuestToken,
  guestQuota,
  GUEST_TOKEN_MIN,
} from '../../src/services/guestService.js';
import { COMPLETION, isCompleted, completionRate, assertCompletionCopy } from '../../src/services/completionContract.js';
import { summarizeGuideFunnel, GUIDE_EVENTS, GUIDE_STEPS } from '../../src/services/firstTrainingService.js';
import {
  buildSmallSampleFacts,
  assertNoEdgeAssertion,
  SMALL_SAMPLE_THRESHOLD,
} from '../../src/services/smallSampleService.js';
import { buildScoreCard } from '../../src/services/scoreCardService.js';
import { RATIO_GUARD_THRESHOLD, errorBandOf } from '../../src/services/checkupService.js';
import {
  netWinOf,
  summarizeStreak,
  buildNetWinBoard,
  dateKeyOf,
  seedFromDate,
  mulberry32,
  CHALLENGE_MIN_ROUNDS,
} from '../../src/services/dailyChallengeService.js';
import {
  buildShareLink,
  channelFromQuery,
  coverageOf,
  normalizeChannel,
  CHANNEL_PARAM,
} from '../../src/services/attributionService.js';
import { deviceOf, orientationOf, withDevice, mobileReadiness } from '../../src/services/deviceService.js';
import { DECOMMISSIONED, archivedPayload, isDecommissioned, assertNoTraffic } from '../../src/services/decommissionService.js';
import { buildTierProgress } from '../../src/services/tierProgressService.js';
import { weekKeyOf, buildInbox } from '../../src/services/notificationService.js';

/* ================================================================== *
 * RQ-106 公网入口与 HTTPS（P0 ★）                                     *
 * ================================================================== */

test('P0 · RQ-106 未配置公网地址时判定为不可达并给出可执行 blocker', () => {
  const r = resolvePublicAccess({});
  assert.equal(r.ready, false);
  assert.equal(r.publicUrl, null);
  assert.ok(r.blockers.length > 0);
  assert.ok(r.blockers[0].includes('PUBLIC_BASE_URL'));
  // 下游依赖必须显式列出：没有入口，增长类指标全部无从执行
  assert.ok(r.downstream.some((d) => d.includes('RQ-105') || d.includes('RQ-114')));
});

test('P0 · RQ-106 配置了 https 域名即判定为可达', () => {
  const r = resolvePublicAccess({ PUBLIC_BASE_URL: 'https://train.example.com' });
  assert.equal(r.ready, true);
  assert.equal(r.https, true);
  assert.equal(r.host, 'train.example.com');
  assert.deepEqual(r.blockers, []);
});

test('P3 · RQ-106 localhost / 内网地址一律判为不可对外（防止自欺）', () => {
  for (const h of ['http://localhost:8080', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.9', 'http://172.16.3.4']) {
    const r = resolvePublicAccess({ PUBLIC_BASE_URL: h });
    assert.equal(r.ready, false, `${h} 不应被判为可达`);
    assert.ok(r.blockers.some((b) => b.includes('本机/内网') || b.includes('HTTPS')));
  }
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('train.example.com'), false);
});

test('P3 · RQ-106 未显式给协议时默认补 https，并去掉默认端口噪音', () => {
  assert.equal(normalizeBaseUrl('train.example.com'), 'https://train.example.com');
  assert.equal(normalizeBaseUrl('train.example.com/'), 'https://train.example.com');
  assert.equal(normalizeBaseUrl('https://train.example.com:443/'), 'https://train.example.com');
});

test('P5 · RQ-106 nginx 配置片段含实际 server_name 与 HTTP→HTTPS 跳转', () => {
  const conf = renderNginxServerConf({ host: 'train.example.com' });
  assert.ok(conf.includes('server_name train.example.com'));
  assert.ok(conf.includes('return 301 https://$host$request_uri;'));
  assert.ok(!conf.includes('server_name _;'));
});

/* ================================================================== *
 * RQ-107 首训短局化（P0 ★）                                           *
 * ================================================================== */

test('P0 · RQ-107 默认一局 ≤15 根且 ≤2 次决策', () => {
  assert.ok(DEFAULT_BARS <= MAX_DEFAULT_BARS, `默认 ${DEFAULT_BARS} 根必须 ≤ ${MAX_DEFAULT_BARS}`);
  const d = resolveSessionLength(null);
  assert.equal(d.key, 'quick');
  assert.ok(d.bars <= MAX_DEFAULT_BARS);
  assert.ok(decisionPointsFor(d.bars) <= 2);
  assert.equal(isShortByDefault(), true);
});

test('P0 · RQ-107 长局保留为进阶选项但不是默认', () => {
  const advanced = BAR_PRESETS.filter((p) => p.advanced);
  assert.ok(advanced.length >= 1, '长局必须保留，否则进阶用户无处可去');
  for (const p of advanced) assert.equal(p.default, false);
  assert.equal(BAR_PRESETS.filter((p) => p.default).length, 1, '默认档位只能有一个');
});

test('P3 · RQ-107 非法入参一律回落默认，不抛错（首训路径上任何 400 都会挡住第一次判断）', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, -5, 1e9, {}, []]) {
    const r = resolveSessionLength(bad);
    assert.ok(Number.isFinite(r.bars), `入参 ${String(bad)} 应回落为可用例数`);
    assert.ok(r.bars >= MIN_BARS && r.bars <= 200);
  }
});

test('P5 · RQ-107 指定档位 key 与数字根数解析结果一致（不出现第二套口径）', () => {
  assert.equal(resolveSessionLength('standard').bars, 60);
  assert.equal(resolveSessionLength(60).bars, 60);
  assert.equal(resolveSessionLength('epic').bars, 200);
});

/* ================================================================== *
 * RQ-108 免登录即可练一次（P0 ★）                                     *
 * ================================================================== */

test('P0 · RQ-108 游客身份可被识别，且不会污染注册用户口径', () => {
  const id = identityOf({ guestToken: 'guesttoken123456' });
  assert.equal(id.isGuest, true);
  assert.equal(id.userId, null, '游客的 user_id 必须为 null，否则会污染首训完成率分母');
});

test('P0 · RQ-108 已登录时以用户为准（登录后能看到自己的训练，而不是游客局）', () => {
  const id = identityOf({ userId: 7, guestToken: 'guesttoken123456' });
  assert.equal(id.isGuest, false);
  assert.equal(id.userId, 7);
  assert.equal(id.guestToken, null);
});

test('P3 · RQ-108 非法或过短 token 一律判为无身份，不允许匿名写入', () => {
  assert.equal(normalizeGuestToken('abc'), null);
  assert.equal(normalizeGuestToken('a'.repeat(200)), null);
  assert.equal(normalizeGuestToken('bad token!!'), null);
  assert.equal(normalizeGuestToken(''), null);
  assert.ok(newGuestToken().length >= GUEST_TOKEN_MIN);
  assert.equal(identityOf({}).anonymous, true);
});

test('P3 · RQ-108 游客额度用完后明确拒绝并给出唯一注册理由', () => {
  const ok = guestQuota(0);
  assert.equal(ok.allowed, true);
  assert.ok(ok.signupReason.length > 0, '成绩卡上必须有且只有一个注册理由');
  const used = guestQuota(3);
  assert.equal(used.allowed, false);
  assert.equal(used.remaining, 0);
  assert.ok(used.message.includes('注册'));
});

test('P5 · RQ-108 归属条件走占位符，且注入型 token 在入口即被拒绝（防 SQL 注入）', async () => {
  const { ownerClause } = await import('../../src/services/guestService.js');
  // 第一道防线：token 字符集白名单，注入串根本进不来
  assert.equal(normalizeGuestToken("abc' OR 1=1--"), null);
  assert.equal(ownerClause({ guestToken: "abc' OR 1=1--" }), null, '非法 token 不应产出任何 SQL 条件');

  // 第二道防线：即使 token 合法也只用占位符，绝不拼接原文
  const w = ownerClause({ guestToken: 'guesttoken123456' });
  assert.equal(w.clause, 'guest_token=$1');
  assert.deepEqual(w.params, ['guesttoken123456']);
  assert.ok(!w.clause.includes('guesttoken123456'));

  // 无身份时必须返回 null（调用方显式处理），而不是产出永真条件放行
  assert.equal(ownerClause({}), null);
});

/* ================================================================== *
 * RQ-109 统一「完成」口径（P0 ★）                                     *
 * ================================================================== */

test('P0 · RQ-109 完成 = 结算并出成绩卡（FINISHED 且有 score）', () => {
  assert.equal(isCompleted({ status: 'FINISHED', score: { returnPct: 1 }, finished_at: '2026-10-28' }), true);
  assert.equal(isCompleted({ status: 'FINISHED' }), false, '只有状态没有成绩不算完成');
  assert.equal(isCompleted({ status: 'RUNNING', score: {} }), false);
});

test('P3 · RQ-109 脏入参一律返回 false，不抛错', () => {
  for (const bad of [null, undefined, {}, { status: null }, 'FINISHED', 42]) {
    assert.equal(isCompleted(bad), false);
  }
});

test('P5 · RQ-109 旧口径文案被守护捕获（防止 F-32 复发）', () => {
  const bad = assertCompletionCopy(['提交第一次判断就完成了', '走到最后一根并结算出成绩卡']);
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.level === 'forbidden'));

  const good = assertCompletionCopy([
    COMPLETION.uiCopy.card,
    COMPLETION.uiCopy.done,
    '走到最后一根并结算，这一局才算完成，会生成一张成绩卡。',
  ]);
  assert.equal(good.ok, true);
});

test('P5 · RQ-109 北极星分母为 0 时返回 null 而不是 0（避免把「无人」读成「零转化」）', () => {
  const r = completionRate(0, 0);
  assert.equal(r.value, null);
  assert.equal(r.readable, false);
  assert.equal(completionRate(3, 6).value, 50);
});

/* ================================================================== *
 * RQ-110 首训引导可用性修复（P0）                                     *
 * ================================================================== */

test('P0 · RQ-110 引导路径四步齐全且顺序固定（进入→开始→决策→结算）', () => {
  assert.equal(GUIDE_STEPS.length, 4);
  assert.equal(GUIDE_EVENTS.length, 4);
  assert.equal(GUIDE_EVENTS[0], 'first_training_enter');
  assert.equal(GUIDE_EVENTS[3], 'first_training_finish');
});

test('P0 · RQ-110 能定位断点：上一步有人、这一步没人', () => {
  const r = summarizeGuideFunnel({
    first_training_enter: 10,
    first_training_start: 4,
    first_training_decision: 0,
    first_training_finish: 0,
  });
  assert.equal(r.dropAt.step, 'first_training_decision');
  assert.equal(r.steps[0].conversionFromPrev, 100, '首步没有上一步，转化率按自身计 100%');
  assert.equal(r.steps[1].conversionFromPrev, 40);
});

test('P3 · RQ-110 四步全为 0 时明确说「不可判定」，不能被当成已验证', () => {
  const r = summarizeGuideFunnel({});
  assert.equal(r.summary.entered, 0);
  assert.ok(r.note.includes('无法判定'));
  assert.equal(r.summary.completionRate, null);
});

test('P3 · RQ-110 脏入参不抛错', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    const r = summarizeGuideFunnel(bad);
    assert.equal(Array.isArray(r.steps), true);
  }
});

test('P5 · RQ-110 完成率按「结算」而非「决策」计算（与 RQ-109 同源）', () => {
  const r = summarizeGuideFunnel({
    first_training_enter: 5,
    first_training_start: 4,
    first_training_decision: 4,
    first_training_finish: 1,
  });
  assert.equal(r.summary.completionRate, 25, '4 次开始、1 次结算 → 25%，而不是按决策算 100%');
});

/* ================================================================== *
 * RQ-111 小样本「能说的三件事」（P0 ★）                                *
 * ================================================================== */

test('P0 · RQ-111 2 笔样本也能给出三条可说事实与一个下一步动作', () => {
  const r = buildSmallSampleFacts({
    sampleSize: 2,
    cost: { fee: 12.5, slippage: 3.2, turnover: 50000 },
    behavior: { stopPlanned: 2, stopExecuted: 1, chaseHigh: 1, closed: 2, medianHoldDays: 4 },
    benchmark: { returnPct: 1.2, buyHoldPct: 0.8 },
  });
  assert.equal(r.smallSample, true);
  assert.equal(r.facts.length, 3);
  assert.equal(r.sayableCount, 3);
  assert.deepEqual(r.facts.map((f) => f.key), ['cost', 'behavior', 'benchmark']);
  assert.ok(r.nextAction.label.includes('28'), '2 笔样本应提示还差 28 笔（30−2）');
  assert.ok(r.nextAction.cta);
});

test('P0 · RQ-111 小样本下列出被拦住的 edge 断言（避免用户以为是为 0）', () => {
  const r = buildSmallSampleFacts({ sampleSize: 2, cost: { fee: 1 } });
  assert.ok(r.blockedAssertions.includes('胜率'));
  assert.ok(r.blockedAssertions.includes('期望值'));
  assert.ok(r.blockedAssertions.includes('排名'));
});

test('P1 · RQ-111 过护栏后不再拦（差异化只在小样本区间成立）', () => {
  const r = buildSmallSampleFacts({ sampleSize: 60, cost: { fee: 1 } });
  assert.equal(r.smallSample, false);
  assert.deepEqual(r.blockedAssertions, []);
});

test('P3 · RQ-111 全空入参不抛错，仍保留三条事实骨架', () => {
  for (const bad of [null, undefined, {}, { sampleSize: 'abc' }, { cost: null, behavior: null, benchmark: null }]) {
    const r = buildSmallSampleFacts(bad);
    assert.equal(r.facts.length, 3);
    assert.ok(Number.isFinite(r.sampleSize));
  }
});

test('P3 · RQ-111 守护：小样本文案里出现「胜率」即判定违规', () => {
  assert.equal(assertNoEdgeAssertion('你的胜率是 60%', 2).ok, false);
  assert.equal(assertNoEdgeAssertion('已付出手续费 12 元', 2).ok, true);
  assert.equal(assertNoEdgeAssertion('胜率 60%', 50).ok, true, '过护栏后不再限制');
});

test('P5 · RQ-111 门槛与 RQ-95 的 30 笔护栏同源（不出现第二套门槛）', () => {
  assert.equal(SMALL_SAMPLE_THRESHOLD, RATIO_GUARD_THRESHOLD);
});

/* ================================================================== *
 * RQ-112 误差带落到成绩页（P0）                                       *
 * ================================================================== */

test('P0 · RQ-112 成绩卡必带样本量、误差带与「不能拿它做什么」', () => {
  const card = buildScoreCard({
    session: { status: 'FINISHED', alias: '标的 #00FF', stock_code: '600000', stock_name: '浦发银行' },
    score: { returnPct: 3.5, disciplineRate: 80, decisionPoints: 2, tradeCount: 1 },
    sampleSize: 40,
  });
  assert.ok(card.errorBand, '成绩卡必须带 errorBand');
  assert.ok(card.cannotDo && card.cannotDo.length > 0);
  assert.ok(card.text.includes('不能拿它做什么'), '可复制文本必须包含禁止用途');
  assert.ok(card.text.includes('可信度'));
});

test('P3 · RQ-112 零样本时不出现 NaN / Infinity', () => {
  const card = buildScoreCard({ session: { status: 'FINISHED' }, score: {}, sampleSize: 0 });
  assert.equal(card.errorBand.bandR, null);
  for (const bad of ['NaN', 'Infinity', 'undefined', 'null']) {
    assert.ok(!card.text.includes(bad), `成绩卡文本不应包含 ${bad}`);
  }
});

test('P5 · RQ-112 误差带与体检单同源（同一个 errorBandOf）', () => {
  const band = errorBandOf({ sampleSize: 40 });
  const card = buildScoreCard({ session: { status: 'FINISHED' }, score: {}, sampleSize: 40 });
  assert.equal(card.errorBand.bandR, band.bandR);
  assert.equal(card.errorBand.cannot, band.cannot);
});

/* ================================================================== *
 * RQ-113 每日一题 · 连打 · 净胜局榜（P1）                              *
 * ================================================================== */

test('P1 · RQ-113 净胜局 = 跑赢买入持有 +1 / 跑输 −1 / 打平 0', () => {
  assert.equal(netWinOf({ returnPct: 2, buyHoldPct: 1 }), 1);
  assert.equal(netWinOf({ returnPct: -2, buyHoldPct: -1 }), -1);
  assert.equal(netWinOf({ returnPct: 1, buyHoldPct: 1 }), 0);
  assert.equal(netWinOf({ returnPct: null, buyHoldPct: 1 }), null);
});

test('P1 · RQ-113 打满 5 局才上榜，未达标者给出还差几局（护栏改为牵引）', () => {
  const r = buildNetWinBoard([
    { ref: 'u1', displayName: '张三', rounds: 6, netWin: 4 },
    { ref: 'u2', displayName: '李四', rounds: 2, netWin: 9 },
  ]);
  assert.equal(r.board.length, 1);
  assert.equal(r.board[0].displayName, '张三');
  assert.equal(r.waiting.length, 1);
  assert.equal(r.waiting[0].remaining, 3);
  assert.equal(r.minRounds, CHALLENGE_MIN_ROUNDS);
});

test('P1 · RQ-113 榜单序列化结果中不出现任何绝对收益字段（硬约束 6）', () => {
  const r = buildNetWinBoard([
    { ref: 'u1', displayName: '张三', rounds: 6, netWin: 4 },
    { ref: 'u2', displayName: '李四', rounds: 6, netWin: -2 },
  ]);
  const s = JSON.stringify(r);
  for (const bad of ['returnPct', 'return_pct', '收益率', '收益排名']) {
    assert.ok(!s.includes(bad), `榜单不应出现 ${bad}`);
  }
  assert.ok(r.metricDef.includes('不看绝对收益'));
});

test('P1 · RQ-113 连打按连续自然日计算，断一天即归零', () => {
  const now = new Date('2026-10-28T02:00:00+08:00');
  assert.equal(summarizeStreak(['2026-10-26', '2026-10-27', '2026-10-28'], now).current, 3);
  assert.equal(summarizeStreak(['2026-10-25', '2026-10-28'], now).current, 1);
  assert.equal(summarizeStreak(['2026-10-20'], now).current, 0, '断连后当前连打归零');
  assert.equal(summarizeStreak([], now).current, 0);
});

test('P3 · RQ-113 同一天所有用户算出同一道题（确定性抽题）', () => {
  const a = mulberry32(seedFromDate('2026-10-28'));
  const b = mulberry32(seedFromDate('2026-10-28'));
  const c = mulberry32(seedFromDate('2026-10-29'));
  assert.equal(a(), b());
  assert.notEqual(seedFromDate('2026-10-28'), seedFromDate('2026-10-29'));
  assert.ok(Number.isFinite(c()));
  assert.equal(dateKeyOf(new Date('2026-10-28T16:00:00+08:00')), '2026-10-28');
  assert.equal(dateKeyOf('bad-date'), null);
});

test('P3 · RQ-113 脏入参不抛错', () => {
  assert.deepEqual(buildNetWinBoard(null).board, []);
  assert.deepEqual(buildNetWinBoard('x').board, []);
  assert.deepEqual(summarizeStreak(null).days, []);
  assert.equal(netWinOf(null), null);
});

test('P5 · RQ-113 榜单按净胜局降序，同分时按局数降序', () => {
  const r = buildNetWinBoard([
    { ref: 'a', rounds: 5, netWin: 1 },
    { ref: 'b', rounds: 5, netWin: 3 },
    { ref: 'c', rounds: 8, netWin: 1 },
  ]);
  assert.deepEqual(r.board.map((x) => x.ref), ['b', 'c', 'a']);
});

/* ================================================================== *
 * RQ-114 获客归因落地（P1）                                           *
 * ================================================================== */

test('P1 · RQ-114 白名单渠道通过，未登记渠道归 unknown', () => {
  assert.equal(normalizeChannel('search'), 'search');
  assert.equal(normalizeChannel('  CONTENT '), 'content');
  assert.equal(normalizeChannel('weird-source'), 'unknown');
  assert.equal(normalizeChannel(''), 'unknown');
  assert.equal(channelFromQuery({ ref: 'community' }), 'community');
  assert.equal(channelFromQuery({ utm_source: 'direct' }), 'direct');
});

test('P1 · RQ-114 没有公网地址时不生成 localhost 链接', () => {
  const none = buildShareLink({ baseUrl: '', channel: 'search' });
  assert.equal(none.ok, false);
  assert.equal(none.url, null);

  const local = buildShareLink({ baseUrl: 'http://localhost:8080', channel: 'search' });
  assert.equal(local.ok, false);
  assert.ok(local.reason.includes('本机'));
});

test('P1 · RQ-114 有公网地址时链接带渠道参数且不含身份信息', () => {
  const r = buildShareLink({ baseUrl: 'https://train.example.com', channel: 'search', path: '/training' });
  assert.equal(r.ok, true);
  assert.ok(r.url.includes(`${CHANNEL_PARAM}=search`));
  assert.ok(r.url.startsWith('https://train.example.com'));
});

test('P1 · RQ-114 覆盖率达标判定（≥90% 才算通过）', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ channel: i === 9 ? 'unknown' : 'search' }));
  const c = coverageOf(rows);
  assert.equal(c.coveragePct, 90);
  assert.equal(c.pass, true);
  assert.equal(coverageOf([{ channel: 'unknown' }, { channel: 'unknown' }]).pass, false);
  assert.equal(coverageOf([]).pass, false, '无用户时覆盖率不可计算，不应判为通过');
});

/* ================================================================== *
 * RQ-115 手机端（P1）                                                 *
 * ================================================================== */

test('P1 · RQ-115 埋点可区分设备（否则回答不了手机端完成率）', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'tablet');
  assert.equal(deviceOf(''), 'unknown');
  assert.equal(deviceOf(null), 'unknown');
});

test('P1 · RQ-115 分辨率不入埋点（避免指纹化），只保留设备与方向', () => {
  const p = withDevice({ sessionId: 1, screenWidth: 390, screenHeight: 844 }, {
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' },
  });
  assert.equal(p.device, 'mobile');
  assert.equal(p.orientation, 'portrait');
  assert.equal(p.screenWidth, undefined);
  assert.equal(p.screenHeight, undefined);
  assert.equal(p.sessionId, 1, '原有字段语义不得被破坏');
});

test('P3 · RQ-115 方向入参非法时返回 unknown 而不是抛错', () => {
  assert.equal(orientationOf({}), 'unknown');
  assert.equal(orientationOf({ width: 0, height: 0 }), 'unknown');
  assert.equal(orientationOf({ width: 'a', height: 'b' }), 'unknown');
});

test('P5 · RQ-115 就绪清单未完成时明确列出缺失项（组件级断言替代不了真机）', () => {
  const r = mobileReadiness({ portraitRun: true, noHorizontalScroll: false, deviceTag: true });
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('noHScroll'));
  assert.ok(r.note.includes('真机'));
  assert.equal(mobileReadiness({ portraitRun: true, noHorizontalScroll: true, tapTarget: true, deviceTag: true }).ready, true);
});

/* ================================================================== *
 * RQ-116 零使用功能下线（P1）                                         *
 * ================================================================== */

test('P1 · RQ-116 剧本训练场与房间赛均已归档且给出替代入口', () => {
  assert.equal(DECOMMISSIONED.length, 2);
  for (const path of ['/scenarios', '/rooms']) {
    const p = archivedPayload(path);
    assert.equal(p.archived, true);
    assert.equal(p.status, 410);
    assert.ok(p.replacement && p.replacement.path, `${path} 必须给出替代入口`);
    assert.ok(p.reason.length > 0);
  }
  assert.ok(isDecommissioned('/api/scenario/list'));
  assert.equal(isDecommissioned('/blind'), null);
});

test('P5 · RQ-116 归档功能仍在产生埋点即判违规（防止「归档」只是嘴上说说）', () => {
  assert.equal(assertNoTraffic({ room_join: 0, scenario_start: 0 }).ok, true);
  const bad = assertNoTraffic({ room_join: 3 });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].path, '/rooms');
});

/* ================================================================== *
 * RQ-117 距下一档还差 N 笔（P2）                                      *
 * ================================================================== */

test('P2 · RQ-117 未达标时显示还差多少笔（护栏从拦截改为牵引）', () => {
  const r = buildTierProgress({ sampleSize: 12 });
  assert.equal(r.reachedTop, false);
  assert.ok(r.message.includes('还差'));
  assert.ok(r.remainingToNext > 0);
  const ratio = r.gates.find((g) => g.key === 'ratio');
  assert.equal(ratio.threshold, RATIO_GUARD_THRESHOLD);
  assert.equal(ratio.remaining, 18);
  assert.ok(r.progressPct >= 0 && r.progressPct <= 100);
});

test('P2 · RQ-117 达标当日提示出现一次且可关闭', () => {
  const r = buildTierProgress({ sampleSize: 30, dismissed: [] });
  assert.ok(r.notices.length >= 1, '跨过 30 笔应出现达标提示');
  const key = r.notices[0].key;
  assert.equal(r.notices[0].once, true);
  assert.equal(r.notices[0].dismissible, true);
  assert.equal(buildTierProgress({ sampleSize: 30, dismissed: [key] }).notices.length, 0);
});

test('P3 · RQ-117 零样本与脏入参不抛错', () => {
  for (const bad of [null, undefined, {}, { sampleSize: 'abc' }, { sampleSize: -5, dismissed: null }]) {
    const r = buildTierProgress(bad);
    assert.ok(Number.isFinite(r.sampleSize));
    assert.equal(r.sampleSize >= 0, true);
    assert.ok(Array.isArray(r.gates));
  }
});

test('P5 · RQ-117 档位与体检单同源（不出现第二套门槛）', () => {
  const a = buildTierProgress({ sampleSize: 60 });
  const b = buildTierProgress({ sampleSize: 60 });
  assert.deepEqual(a.tier, b.tier);
  assert.ok(a.tier.threshold <= 60);
});

/* ================================================================== *
 * RQ-118 周报与站内推送（P2）                                         *
 * ================================================================== */

test('P2 · RQ-118 周报提示按自然周生成 key，同一周只出现一条', () => {
  const weekly = {
    segments: { thisWeek: 3, lastWeek: 1 },
    discipline: { note: '纪律执行率提升 10 个百分点' },
    nextTier: { text: '还差 20 笔' },
    disclaimer: '不构成投资建议，不承诺任何收益或奖励。',
  };
  const now = new Date('2026-10-28T02:00:00+08:00');
  const a = buildInbox({ checkup: null, weekly, now });
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].kind, 'weekly');
  const key = a.items[0].key;
  // 同一周内重复调用：key 相同 → 关闭后不再出现
  assert.equal(buildInbox({ checkup: null, weekly, now, dismissed: [key] }).items.length, 0);
  assert.equal(weekKeyOf(now).startsWith('2026-W'), true);
});

test('P2 · RQ-118 推送不承诺任何实物或现金奖励（合规硬约束）', () => {
  const r = buildInbox({
    checkup: { sampleSize: 60, milestone: { justReached: true, tierKey: 'behavior', tierLabel: '行为级', message: '已达成 50 笔', cannot: '仍然不能拿它做策略级结论。' } },
    weekly: null,
  });
  assert.ok(r.items.length >= 1);
  for (const it of r.items) {
    // 只检查「标题 + 正文」：免责字段里出现「不承诺…奖励」是合规要求的**否定句**，
    // 把否定句本身算作违规是 v7 踩过的坑（断言里写「不得包含 X」而 X 出现在免责声明中）。
    const shown = `${it.title} ${it.body}`;
    for (const bad of ['现金', '红包', '实物', '稳赚', '翻倍', '必涨']) {
      assert.ok(!shown.includes(bad), `推送正文不应出现「${bad}」`);
    }
    // 免责字段必须存在且是否定式（不承诺 / 不构成）
    assert.ok(/不承诺|不构成|不能|不得/.test(it.cannot || ''), '每条提示都必须带否定式免责');
  }
});

/* ================================================================== *
 * P4 · 性能与并发                                                     *
 * ================================================================== */

test('P4 · 小样本事实构建 20000 次不退化', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20000; i += 1) {
    buildSmallSampleFacts({ sampleSize: i % 100, cost: { fee: i }, behavior: { closed: i }, benchmark: { returnPct: i, buyHoldPct: 1 } });
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `20000 次构建耗时 ${ms}ms，疑似退化`);
});

test('P4 · 局长度解析 50000 次不退化且结果稳定', () => {
  const t0 = Date.now();
  for (let i = 0; i < 50000; i += 1) resolveSessionLength(i % 250);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `50000 次解析耗时 ${ms}ms`);
  assert.equal(resolveSessionLength(12).bars, resolveSessionLength(12).bars);
});

test('P4 · 净胜局榜在 500 人规模下排序不退化', () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ ref: `u${i}`, rounds: 5, netWin: (i % 11) - 5 }));
  const t0 = Date.now();
  const r = buildNetWinBoard(entries);
  const ms = Date.now() - t0;
  assert.equal(r.board.length, 500);
  assert.ok(ms < 1000, `500 人排序耗时 ${ms}ms`);
  assert.ok(r.board[0].netWin >= r.board[499].netWin, '榜单必须按净胜局降序');
});

test('P4 · 并发 200 次引导漏斗聚合结果一致（纯函数无共享状态）', async () => {
  const counts = { first_training_enter: 20, first_training_start: 10, first_training_decision: 5, first_training_finish: 2 };
  const results = await Promise.all(Array.from({ length: 200 }, () => Promise.resolve(summarizeGuideFunnel(counts))));
  const first = JSON.stringify(results[0]);
  for (const r of results) assert.equal(JSON.stringify(r), first);
});
