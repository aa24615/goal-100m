/**
 * v12 需求（RQ-142 ~ RQ-155）覆盖测试
 *
 * 测试级别说明（沿用 v7 起的约定，本文件开头只说一次）：
 *   P0 主流程     需求的核心价值路径必须跑通
 *   P1 差异化     与竞品不同的那一点是否真的成立
 *   P2 留存体验   用户会不会再来 / 会不会被劝退
 *   P3 边界异常   脏数据、空值、越界、时区
 *   P4 性能并发   大数据量与并发下的行为
 *   P5 兼容回归   旧口径、旧调用方不能被新代码打破
 *
 * v12 的三条主线：
 *   ① 把门牌号挂上（RQ-142 公网入口）
 *   ② 把水表修好（RQ-143/144/149 度量可信度）
 *   ③ 把龙头拧小（RQ-146/147 短局 + 有效完成门槛）
 * 之后才是「把可信度做成产品语言」（RQ-150~153）与保留承诺（RQ-154）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeKeyOf,
  dedupeRuleOf,
  shouldAccept,
  summarizeDuplicates,
  summarizeConsistency,
  shanghaiDateKey,
  DEDUPE_SCOPES,
  EVENT_DEDUPE,
} from '../../src/services/telemetryIntegrityService.js';

import {
  EFFECTIVE_RULES,
  evaluateEffectiveCompletion,
  effectiveCompletionRate,
  allowFinishTelemetry,
  durationSecOf,
  barProgressOf,
} from '../../src/services/effectiveCompletionService.js';

import {
  THRESHOLDS,
  MIN_SAMPLE,
  tStat,
  confidenceInterval,
  breakevenWinRate,
  buildIntervalConclusion,
  buildConclusionPanel,
} from '../../src/services/intervalConclusionService.js';

import {
  TEST_SIGNALS,
  minuteKeyOf,
  classifySignupBursts,
  classifyEmptySessions,
  planTestMarks,
  isExternalUser,
  summarizeExternalFunnel,
} from '../../src/services/testTrafficService.js';

import {
  RETENTION_POLICY,
  retentionNotice,
  trainingRecordsCsv,
} from '../../src/services/dataRetentionService.js';

import {
  auditPublicEntrypoint,
  parseEnvText,
  serverNamesOf,
  hasHttpToHttpsRedirect,
  isPublicIpv4,
  isLocalHost,
} from '../../src/services/publicAccessService.js';

import {
  classifyRejection,
  buildPriceOrigin,
  buildSettlementAudit,
  settlementAuditCsv,
  SLIPPAGE_RULE,
  REJECTION_RULES,
} from '../../src/services/settlementAuditService.js';

import { BAR_PRESETS, resolveSessionLength, isShortByDefault, DEFAULT_BARS } from '../../src/services/sessionLengthService.js';

/* ================================================================== *
 * RQ-147 有效完成门槛（P0 · v12 头号发现：北极星被空跑刷满）          *
 * ================================================================== */

/** 复刻生产里的 id=8：创建 18:31:15.736 → 完成 18:31:16.026，0 笔成交 */
const EMPTY_RUN = {
  status: 'FINISHED',
  created_at: '2026-10-30T18:31:15.736Z',
  finished_at: '2026-10-30T18:31:16.026Z',
  start_seq: 100,
  end_seq: 111,
  cursor_seq: 111,
  score: { tradeCount: 0, durationSec: 0, feeTotal: 0, returnPct: 0, decisionPoints: 1, disciplineRate: 100 },
};

const GOOD_RUN = {
  status: 'FINISHED',
  created_at: '2026-10-30T18:00:00.000Z',
  finished_at: '2026-10-30T18:03:20.000Z',
  start_seq: 100,
  end_seq: 111,
  cursor_seq: 111,
  score: { tradeCount: 4, durationSec: 200, returnPct: 1.2, disciplineRate: 75 },
};

test('P0 · RQ-147 v12 id=8 的空跑（0 笔成交 / 0.29 秒）不得计为有效完成', () => {
  const r = evaluateEffectiveCompletion({ session: EMPTY_RUN, orderCount: 0 });
  assert.equal(r.completed, true, '形式完成仍为 true（系统确实跑完了）');
  assert.equal(r.effective, false, '有效完成必须为 false，这是本期头号修复');
  assert.ok(r.blockerKeys.includes('no_trade'));
  assert.ok(r.blockerKeys.includes('too_fast'));
  assert.ok(Math.abs(r.durationSec - 0.29) < 0.02, `耗时应为 0.29 秒，实际 ${r.durationSec}`);
});

test('P0 · RQ-147 未达门槛时不出成绩卡，改出「再来一次」引导（F-80）', () => {
  const r = evaluateEffectiveCompletion({ session: EMPTY_RUN, orderCount: 0 });
  assert.equal(r.scoreCard.show, false);
  assert.ok(r.scoreCard.fallback, '必须给出替代引导，不能让用户对着空白发呆');
  assert.match(r.scoreCard.fallback.cta, /再来|继续/);
  assert.ok(['retry', 'continue'].includes(r.scoreCard.fallback.action));
});

test('P0 · RQ-147 有成交、走完、耗时足够的局必须判为有效完成', () => {
  const r = evaluateEffectiveCompletion({ session: GOOD_RUN, orderCount: 4 });
  assert.equal(r.effective, true);
  assert.equal(r.scoreCard.show, true);
  assert.deepEqual(r.blockerKeys, []);
});

test('P0 · RQ-147 score 里 durationSec 为 0 时用 created_at/finished_at 回推，不误判', () => {
  // v12 的 id=8 score.durationSec 恒为 0；只看它会把真走了 3 分钟的局也判成空跑
  const s = { ...GOOD_RUN, score: { ...GOOD_RUN.score, durationSec: 0 } };
  const d = durationSecOf(s, s.score);
  assert.equal(d, 200, '应从时间戳回推出 200 秒');
  const r = evaluateEffectiveCompletion({ session: s, orderCount: 4 });
  assert.equal(r.effective, true, '不得因 score 缺字段把真实训练误判为空跑');
});

test('P0 · RQ-147 埋点闸门：未达有效完成时不发 first_training_finish', () => {
  const bad = evaluateEffectiveCompletion({ session: EMPTY_RUN, orderCount: 0 });
  const g1 = allowFinishTelemetry(bad);
  assert.equal(g1.send, false);
  assert.match(g1.reason, /blocked:/);

  const good = evaluateEffectiveCompletion({ session: GOOD_RUN, orderCount: 4 });
  assert.equal(allowFinishTelemetry(good).send, true);
});

test('P0 · RQ-147 北极星：3/3 的形式完成 100% 与有效完成 0% 必须同时可见', () => {
  const r = effectiveCompletionRate({ started: 3, finished: 3, effective: 0, testExcluded: 2 });
  assert.equal(r.formalValue, 100, '旧口径值保留，用来说明「为什么 100% 是假的」');
  assert.equal(r.value, 0, '新口径必须为 0');
  assert.equal(r.metric, '首训有效完成率');
});

test('P3 · RQ-147 N<5 时 readable 为 false，杜绝 1/1=100% 再次误导决策', () => {
  const r = effectiveCompletionRate({ started: 1, finished: 1, effective: 1 });
  assert.equal(r.value, 100);
  assert.equal(r.readable, false, '样本 1 时数字不可读');
  assert.match(r.note, /样本 1 < 5/);
});

test('P3 · RQ-147 未结算 / 半途结算 / 走太快的三种 blocker 分别可识别', () => {
  const running = evaluateEffectiveCompletion({ session: { status: 'RUNNING' }, orderCount: 3 });
  assert.equal(running.effective, false);
  assert.ok(running.blockerKeys.includes('not_finished'));

  const partial = evaluateEffectiveCompletion({
    session: { ...GOOD_RUN, cursor_seq: 105 },
    orderCount: 4,
  });
  assert.ok(partial.blockerKeys.includes('partial_bars'), '推进 6/12 根应判为 partial_bars');

  // score.durationSec 优先于时间戳（设计如此：时间戳只是 score 缺字段时的回推），
  // 因此要让它算「快」，必须把 score 里的 durationSec 也改掉
  const fast = evaluateEffectiveCompletion({
    session: { ...GOOD_RUN, finished_at: '2026-10-30T18:00:05.000Z', score: { ...GOOD_RUN.score, durationSec: 3 } },
    orderCount: 4,
  });
  assert.ok(fast.blockerKeys.includes('too_fast'));
});

test('P3 · RQ-147 入参为 null / 空对象时不抛错（只读展示类函数的底线）', () => {
  assert.doesNotThrow(() => evaluateEffectiveCompletion(null));
  assert.doesNotThrow(() => evaluateEffectiveCompletion({}));
  const r = evaluateEffectiveCompletion({});
  assert.equal(r.effective, false);
  assert.equal(r.scoreCard.show, false);
  assert.ok(r.scoreCard.fallback, '即使全空也要给出可渲染的引导');
});

test('P3 · RQ-147 缺 seq 时 bars.full 为 null，不猜「已走完」', () => {
  const p = barProgressOf({ start_seq: null, end_seq: null, cursor_seq: null });
  assert.equal(p.full, null);
  const r = evaluateEffectiveCompletion({
    session: { status: 'FINISHED', finished_at: 'x', score: { tradeCount: 2 }, created_at: 'y' },
    orderCount: 2,
  });
  // 没有 seq 就不能断言「走完了」，但也不能因此判空跑——其余门槛通过即算有效
  assert.equal(r.bars.full, null);
});

test('P5 · RQ-147 门槛常量不被悄悄放宽（回归锁）', () => {
  assert.equal(EFFECTIVE_RULES.minTrades, 1);
  assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
  assert.equal(EFFECTIVE_RULES.requireFullBars, true);
  assert.match(EFFECTIVE_RULES.definition, /有效完成/);
});

/* ================================================================== *
 * RQ-146 首训默认短局（P0）                                           *
 * ================================================================== */

test('P0 · RQ-146 默认档位 ≤15 根（此前前端硬编码 60 根，F-79）', () => {
  assert.equal(isShortByDefault(), true);
  const d = BAR_PRESETS.find((p) => p.default);
  assert.ok(d.bars <= 15, `默认 ${d.bars} 根超过 15 根`);
  assert.equal(DEFAULT_BARS, 12);
});

test('P0 · RQ-146 不传参时解析为默认快局，长局需显式指定', () => {
  assert.equal(resolveSessionLength(null).key, 'quick');
  assert.equal(resolveSessionLength(undefined).key, 'quick');
  assert.equal(resolveSessionLength('standard').bars, 60, '长局仍可选，只是不再是默认');
});

test('P3 · RQ-146 非法输入回落默认快局而不是 400（首训路径上不能拦人）', () => {
  assert.equal(resolveSessionLength('abc').key, 'quick');
  assert.equal(resolveSessionLength(-999).bars, 10, '负数被夹到最小长度而不是报错');
  assert.equal(resolveSessionLength(99999).bars, 200);
});

/* ================================================================== *
 * RQ-143 埋点去重（P0）                                              *
 * ================================================================== */

test('P0 · RQ-143 会话级事件按「主体 + 事件 + 会话」去重：单会话 blind_resume ≤1 条', () => {
  const at = Date.parse('2026-10-29T17:06:00.000Z');
  const a = dedupeKeyOf({ userId: 12, event: 'blind_resume', payload: { sessionId: 88 }, at });
  const b = dedupeKeyOf({ userId: 12, event: 'blind_resume', payload: { sessionId: 88 }, at: at + 60000 });
  assert.equal(a, b, '同一会话不同时刻上报必须命中同一个键');
  assert.equal(a, 'u12|blind_resume|s:88');
});

test('P0 · RQ-143 不同会话的同名事件互不影响（去重不得误削真实动作）', () => {
  const at = Date.parse('2026-10-29T17:06:00.000Z');
  const a = dedupeKeyOf({ userId: 12, event: 'blind_resume', payload: { sessionId: 88 }, at });
  const b = dedupeKeyOf({ userId: 12, event: 'blind_resume', payload: { sessionId: 89 }, at });
  assert.notEqual(a, b);
});

test('P0 · RQ-143 游客没有 userId 时用 guestToken 作主体，不能并成一个人', () => {
  const at = Date.parse('2026-10-29T17:06:00.000Z');
  const a = dedupeKeyOf({ userId: null, guestToken: 'tok-A', event: 'blind_start', payload: { sessionId: 1 }, at });
  const b = dedupeKeyOf({ userId: null, guestToken: 'tok-B', event: 'blind_start', payload: { sessionId: 1 }, at });
  assert.notEqual(a, b, '两个游客开同一编号的局不能互相吃掉');
  assert.match(a, /^gtok-A/);
});

test('P1 · RQ-143 浏览类事件用时间窗削峰：同一分钟 228 条会收敛到 1 条', () => {
  const base = Date.parse('2026-10-29T17:06:00.000Z');
  const keys = new Set();
  for (let i = 0; i < 228; i += 1) {
    keys.add(dedupeKeyOf({ userId: 3, event: 'checkup_view', payload: {}, at: base + i * 200 }));
  }
  assert.equal(keys.size, 1, `228 条轮询应压成 1 条，实际 ${keys.size}`);
  assert.equal(EVENT_DEDUPE.checkup_view.scope, DEDUPE_SCOPES.burst);
});

test('P1 · RQ-143 浏览类不按天砍到 1 条：跨窗口的多次真实打开仍分别计数', () => {
  const base = Date.parse('2026-10-29T17:00:00.000Z');
  const a = dedupeKeyOf({ userId: 3, event: 'checkup_view', payload: {}, at: base });
  const b = dedupeKeyOf({ userId: 3, event: 'checkup_view', payload: {}, at: base + 10 * 60 * 1000 });
  assert.notEqual(a, b, '10 分钟后的再次打开应另计一次');
});

test('P1 · RQ-143 一生一次的事件按主体全局唯一（注册、首训）', () => {
  const at = Date.parse('2026-10-29T17:06:00.000Z');
  assert.equal(dedupeKeyOf({ userId: 5, event: 'signup', payload: {}, at }), 'u5|signup');
  assert.equal(dedupeKeyOf({ userId: 5, event: 'first_training_finish', payload: { sessionId: 1 }, at }), 'u5|first_training_finish');
});

test('P1 · RQ-143 按日计数的事件用上海自然日作键（跨时区不得错位）', () => {
  const utcMorning = Date.parse('2026-10-31T00:30:00.000Z'); // 上海 10-31 08:30
  const key = dedupeKeyOf({ userId: 5, event: 'checkin', payload: {}, at: utcMorning });
  assert.equal(key, 'u5|checkin|d:2026-10-31');
  assert.equal(shanghaiDateKey(utcMorning), '2026-10-31');
});

test('P1 · RQ-143 每 10 根一次的合法多次事件不去重（去重会毁掉「每局判断几次」）', () => {
  assert.equal(dedupeKeyOf({ userId: 5, event: 'blind_decision', payload: {}, at: Date.now() }), null);
  assert.equal(EVENT_DEDUPE.blind_decision.scope, DEDUPE_SCOPES.none);
});

test('P3 · RQ-143 会话级事件拿不到 sessionId 时退化为时间窗，不退化成「主体+事件」', () => {
  const at = Date.parse('2026-10-29T17:06:00.000Z');
  const a = dedupeKeyOf({ userId: 7, event: 'blind_resume', payload: {}, at });
  const b = dedupeKeyOf({ userId: 7, event: 'blind_resume', payload: {}, at: at + 10 * 60 * 1000 });
  assert.match(a, /\|w:/, '必须退化为时间窗键');
  assert.notEqual(a, b, '退化后仍不能把后续所有事件都吃掉');
});

test('P3 · RQ-143 未登记事件按浏览类兜底（宁可少记，也不让轮询灌满漏斗）', () => {
  assert.equal(dedupeRuleOf('some_future_event').scope, DEDUPE_SCOPES.burst);
});

test('P3 · RQ-143 入参为空时不抛错', () => {
  assert.doesNotThrow(() => dedupeKeyOf(null));
  assert.doesNotThrow(() => dedupeKeyOf({}));
  assert.equal(dedupeKeyOf({}), null, '没有事件名时不去重');
});

test('P3 · RQ-143 shouldAccept 对已见键返回 duplicate', () => {
  const seen = new Set(['u1|signup']);
  assert.equal(shouldAccept(seen, 'u1|signup').accept, false);
  assert.equal(shouldAccept(seen, 'u1|signup').reason, 'duplicate');
  assert.equal(shouldAccept(seen, null).accept, true, '无去重键一律放行');
  assert.equal(shouldAccept(['u1|signup'], 'u1|signup').accept, false, '数组也能当 seen');
});

/* ================================================================== *
 * RQ-143 / RQ-144 重复汇总与一致性对账（P0）                          *
 * ================================================================== */

test('P0 · RQ-143 重复汇总：714 条 / 2 用户的场景能被量化出来', () => {
  const r = summarizeDuplicates([
    { event: 'blind_resume', user_id: 1, dedupe_key: 'u1|blind_resume|s:5', cnt: 228 },
    { event: 'blind_resume', user_id: 2, dedupe_key: 'u2|blind_resume|s:6', cnt: 200 },
    { event: 'checkup_view', user_id: 1, dedupe_key: 'u1|checkup_view|w:1', cnt: 3 },
  ]);
  assert.equal(r.duplicateKeys, 3);
  assert.equal(r.excessEvents, 227 + 199 + 2);
  assert.equal(r.ok, false);
  assert.match(r.note, /不可信/);
  const top = r.byEvent.find((e) => e.event === 'blind_resume');
  assert.equal(top.maxCount, 228);
});

test('P3 · RQ-143 无重复时 ok 为 true（不能把「没查」当成「没问题」）', () => {
  const r = summarizeDuplicates([]);
  assert.equal(r.ok, true);
  assert.equal(r.duplicateKeys, 0);
  assert.doesNotThrow(() => summarizeDuplicates(null));
});

test('P0 · RQ-144 一致性对账：blind_finish 3 条 vs FINISHED 会话 2 条必须报错', () => {
  const r = summarizeConsistency({
    eventCounts: { blind_finish: 3, blind_start: 10 },
    tableCounts: { blind_sessions_finished: 2, blind_sessions: 10 },
  });
  const item = r.items.find((i) => i.key === 'blind_finish');
  assert.equal(item.match, false);
  assert.equal(item.diff, 1);
  assert.equal(item.severity, 'error');
  assert.match(item.hint, /重复上报/);
  assert.equal(r.ok, false);
});

test('P3 · RQ-144 埋点少于业务表同样是缺陷（漏报），hint 要说反方向', () => {
  const r = summarizeConsistency({
    eventCounts: { blind_finish: 1 },
    tableCounts: { blind_sessions_finished: 4 },
  });
  const item = r.items.find((i) => i.key === 'blind_finish');
  assert.equal(item.diff, -3);
  assert.equal(item.severity, 'error');
  assert.match(item.hint, /漏报/);
});

test('P5 · RQ-144 全部一致时 ok 为 true，且不因缺字段而崩', () => {
  const r = summarizeConsistency({ eventCounts: { blind_start: 5 }, tableCounts: { blind_sessions: 5 } });
  const start = r.items.find((i) => i.key === 'blind_start');
  assert.equal(start.match, true);
  assert.doesNotThrow(() => summarizeConsistency(null));
  assert.doesNotThrow(() => summarizeConsistency({}));
});

/* ================================================================== *
 * RQ-149 自测批次标记 / RQ-148 外部真实用户（P0/P1）                  *
 * ================================================================== */

test('P0 · RQ-149 同分钟注册 ≥3 人识别为自测批次', () => {
  const rows = [10, 11, 12].map((id) => ({ id, createdAt: '2026-10-28T10:05:20.000Z' }));
  const r = classifySignupBursts(rows);
  assert.deepEqual(r.userIds.sort((a, b) => a - b), [10, 11, 12]);
  assert.equal(r.groups[0].count, 3);
  assert.equal(TEST_SIGNALS.signupBurstMinUsers, 3);
});

test('P0 · RQ-149 分散注册的真实用户不得被误标', () => {
  const rows = [
    { id: 1, createdAt: '2026-10-28T10:05:20.000Z' },
    { id: 2, createdAt: '2026-10-28T11:07:21.000Z' },
    { id: 3, createdAt: '2026-10-29T09:00:00.000Z' },
  ];
  assert.deepEqual(classifySignupBursts(rows).userIds, []);
});

test('P0 · RQ-149 会话时长 <30 秒记为空跑', () => {
  const r = classifyEmptySessions([{ id: 8, durationSec: 0.29, tradeCount: 0, finishedAt: 'x' }]);
  assert.deepEqual(r.sessionIds, [8]);
  assert.equal(r.hits[0].reason, 'empty-run:too-fast');
});

test('P1 · RQ-149 0 笔成交却已结算的局同样记为空跑', () => {
  const r = classifyEmptySessions([{ id: 9, durationSec: 300, tradeCount: 0, status: 'FINISHED' }]);
  assert.deepEqual(r.sessionIds, [9]);
  assert.equal(r.hits[0].reason, 'empty-run:no-trade');
});

test('P3 · RQ-149 durationSec 缺失（数据不全）不判为测试流量', () => {
  const r = classifyEmptySessions([{ id: 10, durationSec: null, tradeCount: null, status: 'FINISHED' }]);
  assert.deepEqual(r.sessionIds, [], '数据缺失 ≠ 自测，误标会让真实局被永久排除');
});

test('P3 · RQ-149 planTestMarks 只出计划不改数据，且理由可读', () => {
  const plan = planTestMarks({
    users: [10, 11, 12].map((id) => ({ id, createdAt: '2026-10-28T10:05:20.000Z' })),
    sessions: [{ id: 8, durationSec: 0.29, tradeCount: 0, finishedAt: 'x' }],
  });
  assert.equal(plan.total, 4);
  assert.ok(plan.userReasons[0].detail.includes('3 人'), '理由必须写清「为什么」，三个月后才查得出来');
  assert.match(plan.note, /识别到/);
  assert.doesNotThrow(() => planTestMarks({}));
});

test('P0 · RQ-148 外部真实用户判定：测试标记 / 内部渠道 / 无 IP 一律不算外部', () => {
  assert.equal(isExternalUser({ is_test: true, signup_ip: '1.2.3.4' }).external, false);
  assert.equal(isExternalUser({ acquisition_channel: 'self', signup_ip: '1.2.3.4' }).external, false);
  assert.equal(isExternalUser({ acquisition_channel: 'community', signup_ip: '' }).external, false);
  assert.equal(isExternalUser({ acquisition_channel: 'community', signup_ip: '1.2.3.4' }, { teamIps: ['1.2.3.4'] }).external, false);
});

test('P0 · RQ-148 公网 IP + 非内部渠道判定为外部真实用户', () => {
  const r = isExternalUser(
    { acquisition_channel: 'community', signup_ip: '223.5.5.5' },
    { isPublicIpv4, isLocalHost }
  );
  assert.equal(r.external, true);
  assert.equal(r.reason, 'ok');
});

test('P3 · RQ-148 内网 IP 不算外部（与 publicAccessService 同口径，不另写一套）', () => {
  const r = isExternalUser(
    { acquisition_channel: 'community', signup_ip: '192.168.1.7' },
    { isPublicIpv4, isLocalHost }
  );
  assert.equal(r.external, false);
  assert.equal(r.reason, 'private-ip');
});

test('P0 · RQ-148 外部漏斗：≥5 注册且 ≥2 有效完成才算达成，并给出每步流失', () => {
  const r = summarizeExternalFunnel({ invited: 12, registered: 5, started: 3, effective: 2 });
  assert.equal(r.met, true);
  const lost = r.dropoffs.find((d) => d.to === 'started');
  assert.equal(lost.lost, 2, '注册到开训流失 2 人');
  assert.equal(r.dropAt, null);
});

test('P1 · RQ-148 未达成时指出断点在哪一步（验收要求「记录每一步流失点」）', () => {
  const r = summarizeExternalFunnel({ invited: 10, registered: 5, started: 3, effective: 0 });
  assert.equal(r.met, false);
  assert.equal(r.dropAt.step, 'effective');
  assert.match(r.note, /断点/);
});

test('P3 · RQ-148 全 0 时不断言断点，且入参为空不抛错', () => {
  const r = summarizeExternalFunnel({});
  assert.equal(r.met, false);
  assert.equal(r.dropAt, null, '全 0 时没有「上一步有人」这一步，不该编造断点');
  assert.doesNotThrow(() => summarizeExternalFunnel(null));
});

/* ================================================================== *
 * RQ-142 公网入口（P0 · 连续三版未完成，本期必须可断言）              *
 * ================================================================== */

const GOOD_NGINX = `server {
  listen 80;
  server_name train.example.com;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  server_name train.example.com;
}`;

test('P0 · RQ-142 三处文件都配好时 ready 为 true、blockers 为空', () => {
  const r = auditPublicEntrypoint({
    envText: 'JWT_SECRET=xxx\nPUBLIC_BASE_URL=https://train.example.com',
    nginxText: GOOD_NGINX,
    readmeText: '入口：https://train.example.com',
    smoke: true,
  });
  assert.equal(r.ready, true, `不应有阻断项：${r.blockers.join('；')}`);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.host, 'train.example.com');
});

test('P0 · RQ-142 当前生产状态（.env 只有 JWT_SECRET、nginx server_name _）必须被判为阻断', () => {
  const r = auditPublicEntrypoint({
    envText: 'JWT_SECRET=please-change-this-secret',
    nginxText: 'server { listen 80; server_name _; }',
    readmeText: '打开 http://localhost:8080',
  });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.some((b) => b.includes('PUBLIC_BASE_URL')), '缺 .env 配置必须阻断');
  assert.ok(r.blockers.some((b) => b.includes('server_name')), 'server_name 仍为 _ 必须阻断');
  assert.ok(r.blockers.some((b) => b.includes('README')), 'README 仍写 localhost 必须阻断');
});

test('P3 · RQ-142 .env 配了 localhost 视为不可对外（防止自欺）', () => {
  const r = auditPublicEntrypoint({
    envText: 'PUBLIC_BASE_URL=http://localhost:8080',
    nginxText: GOOD_NGINX,
    readmeText: 'https://train.example.com',
  });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.some((b) => b.includes('本机/内网')));
});

test('P3 · RQ-142 nginx 域名与 .env 域名不一致必须报出来（两边各写各的是常见事故）', () => {
  const r = auditPublicEntrypoint({
    envText: 'PUBLIC_BASE_URL=https://a.example.com',
    nginxText: 'server { listen 80; server_name b.example.com; return 301 https://$host$request_uri; }\nserver { listen 443 ssl; server_name b.example.com; }',
    readmeText: 'https://a.example.com',
  });
  assert.ok(r.blockers.some((b) => b.includes('不一致')));
});

test('P3 · RQ-142 解析函数对空输入与注释行的处理', () => {
  assert.deepEqual(parseEnvText(''), {});
  assert.deepEqual(parseEnvText('# 注释\n\nA=1\nB="2"'), { A: '1', B: '2' });
  assert.deepEqual(serverNamesOf('server_name _;'), [], '_ 不算真实域名');
  assert.deepEqual(serverNamesOf('server_name a.com b.com;'), ['a.com', 'b.com']);
  assert.equal(hasHttpToHttpsRedirect('return 301 https://$host$request_uri;'), true);
  assert.equal(hasHttpToHttpsRedirect('listen 80;'), false);
  assert.doesNotThrow(() => auditPublicEntrypoint(null));
});

/* ================================================================== *
 * RQ-150 结算口径说明书（P1 · 同时消除 F-78 零引用缺陷）              *
 * ================================================================== */

test('P0 · RQ-150 每笔成交的撮合价可溯源到具体那一根 K 线', () => {
  const o = buildPriceOrigin({ seq: 5, price: 10.02, bars: [{ seq: 5, close: 10.02 }] });
  assert.equal(o.matched, true);
  assert.equal(o.hasQuote, true);
  assert.match(o.note, /第 5 根/);
});

test('P1 · RQ-150 撮合价与收盘价不一致时如实判为偏离，不粉饰', () => {
  const o = buildPriceOrigin({ seq: 5, price: 11.5, bars: [{ seq: 5, close: 10.02 }] });
  assert.equal(o.matched, false);
  assert.match(o.note, /不一致/);
});

test('P3 · RQ-150 取不到 K 线时说「无报价」，绝不把 null 显示成 0 元成交', () => {
  const o = buildPriceOrigin({ seq: 5, price: null, bars: [] });
  assert.equal(o.hasQuote, false);
  assert.equal(o.price, null);
  assert.match(o.note, /无法溯源/);
});

test('P0 · RQ-150 被拒绝的委托归类到规则条款，并给出「怎么核对 + 下一步」', () => {
  const c = classifyRejection('当日买入的仓位当日不可卖出');
  assert.equal(c.known, true);
  assert.equal(c.key, 't1');
  assert.ok(c.howToVerify && c.fix, '只丢一句「交易失败」对用户毫无帮助');
});

test('P3 · RQ-150 未知原因归为 unknown 并说明「这是我们的缺陷」', () => {
  const c = classifyRejection('一些没见过的报错');
  assert.equal(c.known, false);
  assert.equal(c.key, 'unknown');
  assert.match(c.fix, /我们的缺陷/);
  const empty = classifyRejection('');
  assert.equal(empty.known, false, '空原因不得假装认识了');
});

test('P1 · RQ-150 差异清单 ≥5 条（验收硬指标）', () => {
  const a = buildSettlementAudit({
    orders: [{ seq: 5, side: 'BUY', quantity: 100, price: 10, amount: 1000, fee: 5.01, realized_pnl: 0 }],
    rejections: [{ seq: 6, side: 'SELL', quantity: 100, reason: '当日不可卖' }],
    bars: [{ seq: 5, close: 10 }],
    session: { status: 'FINISHED' },
    score: { returnPct: 1.2 },
  });
  assert.ok(a.rules.length >= 5, `差异清单应 ≥5 条，实际 ${a.rules.length}`);
  assert.equal(a.rejectionCount, 1);
  assert.equal(a.audit.ok, true, '价格与费用都核对一致时应声称可核对');
  assert.equal(a.slippageRule.hasModel, false, '滑点必须如实写 0，不能编造模型');
});

test('P3 · RQ-150 未揭示时不得泄露标的代码（双盲红线，P5 回归）', () => {
  const a = buildSettlementAudit({
    orders: [{ seq: 5, side: 'BUY', quantity: 100, price: 10, amount: 1000, fee: 5, realized_pnl: 0, stock_code: '600000' }],
    rejections: [{ seq: 6, side: 'SELL', quantity: 100, reason: '资金不足', stock_code: '600000' }],
    session: { status: 'RUNNING' },
  });
  assert.equal(a.orders[0].code, null);
  assert.equal(a.rejections[0].code, null);
});

test('P4 · RQ-150 CSV 导出包含成交与拒绝两类，且与页面行数一致', () => {
  const a = buildSettlementAudit({
    orders: [
      { seq: 5, side: 'BUY', quantity: 100, price: 10, amount: 1000, fee: 5, realized_pnl: 0 },
      { seq: 8, side: 'SELL', quantity: 100, price: 11, amount: 1100, fee: 6, realized_pnl: 90 },
    ],
    rejections: [{ seq: 6, side: 'SELL', quantity: 100, reason: '涨停' }],
    bars: [{ seq: 5, close: 10 }, { seq: 8, close: 11 }],
    session: { status: 'FINISHED' },
  });
  const csv = settlementAuditCsv(a);
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.length, 1 + 3, '表头 1 + 成交 2 + 拒绝 1');
  assert.ok(csv.includes('拒绝'), '页面看得到拒绝，导出就不能少');
  assert.doesNotThrow(() => settlementAuditCsv(null));
});

/* ================================================================== *
 * RQ-152 / RQ-153 区间化结论（P1）                                    *
 * ================================================================== */

test('P0 · RQ-152 t 统计量：t = E·√n/σ（xtradingtime 六硬指标口径）', () => {
  assert.equal(tStat({ mean: 0.5, sigma: 2, n: 64 }), 2);
  assert.equal(tStat({ mean: 1, sigma: 2, n: 16 }), 2);
});

test('P3 · RQ-152 σ≤0 或 n≤0 时 t 返回 null，绝不让 Infinity 进页面', () => {
  assert.equal(tStat({ mean: 1, sigma: 0, n: 10 }), null);
  assert.equal(tStat({ mean: 1, sigma: 2, n: 0 }), null);
  assert.equal(tStat({}), null);
});

test('P0 · RQ-152 95% 置信区间：E ± 1.96σ/√n', () => {
  const ci = confidenceInterval({ mean: 0.5, sigma: 2, n: 64 });
  assert.ok(Math.abs(ci.half - 0.49) < 0.001);
  assert.ok(Math.abs(ci.low - 0.01) < 0.001);
  assert.ok(Math.abs(ci.high - 0.99) < 0.001);
});

test('P1 · RQ-152 盈亏平衡胜率 = 平均亏损 /(平均盈利 + 平均亏损)', () => {
  assert.equal(breakevenWinRate({ avgWin: 2, avgLoss: 1 }), 0.3333);
  assert.equal(breakevenWinRate({ avgWin: 1, avgLoss: 3 }), 0.75);
  assert.equal(breakevenWinRate({}), null, '缺均值时不猜一个 50% 出来');
});

test('P0 · RQ-152 样本不足时**禁止点估计**：所有 point 必须为 null', () => {
  const r = buildIntervalConclusion({ sampleSize: 12, expectancyR: 0.4, sigma: 2, winRate: 0.6, disciplineRate: 0.9 });
  assert.equal(r.insufficient, true);
  for (const m of r.metrics) {
    assert.equal(m.point, null, `${m.key} 在小样本下不得给出点估计（F-19 复发路径）`);
    assert.equal(m.interval, null);
    assert.equal(m.conclusive, false);
    assert.ok(m.remaining > 0);
    assert.match(m.verdict.text, /还差 \d+ 笔/);
  }
  assert.equal(r.guard.ok, true);
});

test('P0 · RQ-152 样本 ≥50 笔时给出区间、t 值与达标线', () => {
  const r = buildIntervalConclusion({ sampleSize: 64, expectancyR: 0.5, sigma: 2, winRate: 0.6, avgWin: 2, avgLoss: 1, disciplineRate: 0.85 });
  assert.equal(r.insufficient, false);
  const exp = r.metrics.find((m) => m.key === 'expectancy');
  assert.ok(exp.point != null);
  assert.ok(exp.interval, '必须给区间');
  assert.equal(exp.t, 2, 't=0.5*8/2=2');
  assert.equal(exp.pass, true, 't=2 > 1.96 应判过线');
  const dis = r.metrics.find((m) => m.key === 'disciplineRate');
  assert.equal(dis.pass, true, '执行率 0.85 ≥ 0.8 应过线');
});

test('P1 · RQ-152 未过线的指标必须写明未过线，而不是悄悄隐藏', () => {
  const r = buildIntervalConclusion({ sampleSize: 64, expectancyR: 0.1, sigma: 2, disciplineRate: 0.5 });
  const exp = r.metrics.find((m) => m.key === 'expectancy');
  assert.equal(exp.pass, false, 't = 0.1*8/2 = 0.4 < 1.96');
  assert.equal(exp.verdict.level, 'fail');
  assert.match(exp.verdict.text, /未通过/);
  assert.ok(exp.verdict.canSay, '未过线要说明为什么这条线重要');
});

test('P3 · RQ-152 达标线常量与验收一致（t>1.96 / 执行率≥80% / 平衡胜率+5pp）', () => {
  assert.equal(THRESHOLDS.tValue.value, 1.96);
  assert.equal(THRESHOLDS.tValue.op, '>');
  assert.equal(THRESHOLDS.disciplineRate.value, 0.8);
  assert.equal(THRESHOLDS.breakevenMargin.value, 0.05);
  assert.equal(MIN_SAMPLE, 50);
});

test('P3 · RQ-152 入参为空时全部降级为「还差 N 笔」，不抛错', () => {
  const r = buildIntervalConclusion(null);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.insufficient, true);
  assert.equal(r.guard.ok, true);
  assert.ok(r.metrics.every((m) => m.point === null));
});

test('P0 · RQ-153 样本 <50 时结论面板走 three-facts，不给区间', () => {
  const p = buildConclusionPanel({
    sampleSize: 12,
    smallSample: { cost: { fee: 12, slippage: 0, turnover: 8000 } },
  });
  assert.equal(p.mode, 'three-facts');
  assert.ok(p.facts, '小样本必须给三件事');
  assert.equal(p.interval, null, '小样本不得给区间结论');
  assert.equal(p.remaining, 38);
  assert.match(p.headline, /还差 38 笔/);
});

test('P0 · RQ-153 样本 ≥50 时结论面板走 interval，不再渲染三件事', () => {
  const p = buildConclusionPanel({ sampleSize: 60, expectancyR: 0.5, sigma: 2 });
  assert.equal(p.mode, 'interval');
  assert.ok(p.interval);
  assert.equal(p.facts, null);
});

/* ================================================================== *
 * RQ-154 数据保留期与导出（P2）                                       *
 * ================================================================== */

test('P0 · RQ-154 登录用户明示永久保留', () => {
  const r = retentionNotice({ isGuest: false });
  assert.equal(r.isGuest, false);
  assert.match(r.title, /永久保留/);
  assert.equal(r.daysLeft, null);
  assert.equal(r.urgent, false);
});

test('P0 · RQ-154 游客明示 7 天，第 5 天起提醒转登录', () => {
  const early = retentionNotice({ isGuest: true, ageDays: 2, sessionCount: 3 });
  assert.equal(early.remind, false, '第 2 天不该打扰');
  assert.equal(early.daysLeft, 5);

  const late = retentionNotice({ isGuest: true, ageDays: 5, sessionCount: 3 });
  assert.equal(late.remind, true);
  assert.equal(late.daysLeft, 2, '留 2 天缓冲，不能「今天提醒明天就没了」');
  assert.equal(late.urgent, true);
  assert.ok(late.cta, '提醒必须带注册出口');
});

test('P3 · RQ-154 游客超过 7 天时 daysLeft 夹到 0，不出现负数', () => {
  const r = retentionNotice({ isGuest: true, ageDays: 30 });
  assert.equal(r.daysLeft, 0);
  assert.equal(r.urgent, true);
});

test('P3 · RQ-154 入参为空时按游客兜底且不抛错', () => {
  assert.doesNotThrow(() => retentionNotice(null));
  const r = retentionNotice({});
  assert.equal(r.isGuest, false, '缺省按登录口径，是更保守的承诺');
});

test('P1 · RQ-154 导出 CSV 与页面列同源，含有效完成列', () => {
  const csv = trainingRecordsCsv([
    { id: 9, alias: '标的#1', status: 'FINISHED', preset: 'quick', score: { returnPct: 1.2, tradeCount: 2, durationSec: 120 }, completed: true, effective: true, createdAt: 'x' },
    { id: 10, alias: '标的#2', status: 'FINISHED', preset: 'quick', score: { tradeCount: 0, durationSec: 0 }, completed: true, effective: false, createdAt: 'y' },
  ]);
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('有效完成'), '导出要能区分有效完成与空跑');
  assert.ok(lines[2].includes('否'), '第二局有效完成为否');
  assert.doesNotThrow(() => trainingRecordsCsv(null));
});

test('P5 · RQ-154 保留期承诺是常量且游客不承诺永久（防「页面说永久、实际 7 天」）', () => {
  assert.equal(RETENTION_POLICY.loggedIn.days, null);
  assert.equal(RETENTION_POLICY.guest.days, 7);
  assert.equal(RETENTION_POLICY.remindFromDay, 5);
});

/* ================================================================== *
 * P4 · 性能与并发                                                     *
 * ================================================================== */

test('P4 · RQ-143 十万次建键应在 1 秒内完成（埋点在每次请求路径上）', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100000; i += 1) {
    dedupeKeyOf({ userId: i % 1000, event: 'checkup_view', payload: {}, at: t0 + i });
  }
  const cost = Date.now() - t0;
  assert.ok(cost < 1000, `10 万次建键耗时 ${cost}ms，超过 1 秒`);
});

test('P4 · RQ-149 五万条注册行的批量识别在 2 秒内完成', () => {
  const rows = Array.from({ length: 50000 }, (_, i) => ({ id: i, createdAt: new Date(Date.parse('2026-10-28T10:00:00.000Z') + (i % 600) * 1000).toISOString() }));
  const t0 = Date.now();
  const r = classifySignupBursts(rows);
  const cost = Date.now() - t0;
  assert.ok(cost < 2000, `耗时 ${cost}ms`);
  assert.ok(r.groups.length > 0);
});

test('P4 · RQ-147 两万次有效完成判定在 1 秒内完成（结算路径上同步调用）', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20000; i += 1) evaluateEffectiveCompletion({ session: GOOD_RUN, orderCount: 4 });
  const cost = Date.now() - t0;
  assert.ok(cost < 1000, `耗时 ${cost}ms`);
});

/* ================================================================== *
 * P5 · 兼容与回归                                                     *
 * ================================================================== */

test('P5 · RQ-150 结算服务与审计服务共用同一套费用口径（不出现第二口径）', async () => {
  const { feeBreakdown } = await import('../../src/services/settlementService.js');
  const f = feeBreakdown(10000, 'SELL');
  const a = buildSettlementAudit({
    orders: [{ seq: 1, side: 'SELL', quantity: 1000, price: 10, amount: 10000, fee: null, realized_pnl: 0 }],
    session: { status: 'FINISHED' },
  });
  assert.equal(a.orders[0].feeBreakdown.commission, f.commission);
  assert.equal(a.orders[0].feeBreakdown.stamp, f.stamp);
  assert.equal(a.orders[0].feeBreakdown.transfer, f.transfer);
});

test('P5 · RQ-143 去重不得破坏既有「完成」口径（completionContract 仍然成立）', async () => {
  const { isCompleted } = await import('../../src/services/completionContract.js');
  assert.equal(isCompleted(GOOD_RUN), true);
  assert.equal(isCompleted({ status: 'RUNNING', score: {} }), false);
  // 新口径是在旧口径之上加条件，不是替换它
  const r = evaluateEffectiveCompletion({ session: GOOD_RUN, orderCount: 4 });
  assert.equal(r.completed, isCompleted(GOOD_RUN));
  assert.equal(r.effective, true);
});

test('P5 · RQ-146 短局化不得改变既有的 60 根标准局（旧调用方传 60 仍得到 60）', () => {
  assert.equal(resolveSessionLength(60).bars, 60);
  assert.equal(resolveSessionLength('standard').bars, 60);
});

test('P5 · RQ-150 拒绝规则表顺序敏感：越具体的排越前', () => {
  const keys = REJECTION_RULES.map((r) => r.key);
  assert.ok(keys.indexOf('t1') < keys.indexOf('cash'), 'T+1 必须先于通用资金规则匹配');
  assert.ok(REJECTION_RULES.length >= 5);
  assert.equal(SLIPPAGE_RULE.hasModel, false);
});
