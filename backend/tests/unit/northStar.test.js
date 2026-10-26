/**
 * RQ-98 北极星切换（首训完成率） / RQ-105 首批真实用户获客实验 —— 单元测试
 *
 * 优先级模型：
 *   P0 核心主流程：北极星可读、7 日留存不可读时必须标注
 *   P1 差异化功能：获客渠道分渠道首训完成率
 *   P3 边界与异常：0 用户、脏入参、未知渠道
 *   P4 性能：大样本聚合不退化
 *   P5 兼容性与回归：指标名与口径常量稳定
 *
 * 背景：v7 把北极星定为 7 日留存，但发布 21 小时、真实用户约 2 人时
 * 这个数字**名义可观测、实质不可读**（F-20）。本期改为首训完成率。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeNorthStar,
  summarizeAcquisition,
  normalizeChannel,
  ACQUISITION_CHANNELS,
  UNKNOWN_CHANNEL,
  RETENTION_MIN_SAMPLE,
} from '../../src/services/northStarService.js';

/* ===================== P0 · RQ-98 北极星主流程 ===================== */

test('P0 · RQ-98 当前阶段北极星为「首训完成率」，先做到 > 0', () => {
  const n = summarizeNorthStar({
    registeredUsers: 6,
    usersWithFirstDecision: 1,
    retentionCohortUsers: 2,
    retentionValue: null,
    firstUserDate: '2026-10-26',
    now: '2026-10-27',
  });
  assert.equal(n.current.metric, '首训完成率');
  assert.equal(n.current.value, 16.67, '1/6 = 16.67%');
  assert.equal(n.current.numerator, 1);
  assert.equal(n.current.denominator, 6);
  assert.equal(n.current.readable, true);
  assert.match(n.current.target, /先 > 0/);
});

test('P0 · RQ-98 样本不足时 7 日留存标注「样本充足后启用」而非给结论', () => {
  const n = summarizeNorthStar({
    registeredUsers: 6,
    usersWithFirstDecision: 0,
    retentionCohortUsers: 2,
    retentionValue: 33.3,
    firstUserDate: '2026-10-26',
    now: '2026-10-27',
  });
  assert.equal(n.formal.enabled, false, 'N=2 < 30，不得启用');
  assert.equal(n.formal.metric, '7 日留存率');
  assert.equal(n.formal.minSample, RETENTION_MIN_SAMPLE);
  assert.match(n.formal.reason, /未达 30 人/);
  assert.equal(n.formal.earliestReadableDate, '2026-11-02', '首个满 7 日窗口的日期');
  // 关键：即使后端算出了留存值，未启用时也不该被当结论用
  assert.ok(n.disclaimer.includes('不作为决策依据'));
});

test('P0 · RQ-98 样本充足后 7 日留存自动启用', () => {
  const n = summarizeNorthStar({
    registeredUsers: 100,
    usersWithFirstDecision: 40,
    retentionCohortUsers: 60,
    retentionValue: 25,
    firstUserDate: '2026-09-01',
    now: '2026-10-27',
  });
  assert.equal(n.formal.enabled, true);
  assert.equal(n.formal.value, 25);
  assert.equal(n.current.value, 40);
});

/* ===================== P1 · RQ-98 口径与展示 ===================== */

test('P1 · RQ-98 分子不超过分母（脏数据不会算出 >100% 的完成率）', () => {
  const n = summarizeNorthStar({ registeredUsers: 3, usersWithFirstDecision: 10 });
  assert.equal(n.current.numerator, 3);
  assert.equal(n.current.value, 100);
});

/* ===================== P3 · RQ-98 边界与异常 ===================== */

test('P3 · RQ-98 零注册用户时指标不可计算，返回 null 而不是 NaN', () => {
  const n = summarizeNorthStar({ registeredUsers: 0, usersWithFirstDecision: 0 });
  assert.equal(n.current.readable, false);
  assert.equal(n.current.value, null);
  const text = JSON.stringify(n);
  assert.ok(!text.includes('NaN'));
  assert.ok(!text.includes('Infinity'));
});

test('P3 · RQ-98 脏入参（null / 负数 / 字符串 / 缺字段）不抛错', () => {
  for (const bad of [null, undefined, {}, { registeredUsers: -5 }, { registeredUsers: 'abc' }]) {
    const n = summarizeNorthStar(bad);
    assert.ok(n.current, `入参 ${String(bad)} 应返回结构而不是抛错`);
    assert.ok(Number.isFinite(n.current.numerator));
    assert.ok(Number.isFinite(n.current.denominator));
  }
  assert.doesNotThrow(() => summarizeNorthStar());
});

/* ===================== P4 · RQ-98 性能 ===================== */

test('P4 · RQ-98 北极星聚合连续 20000 次调用不退化', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20000; i += 1) {
    summarizeNorthStar({ registeredUsers: 100, usersWithFirstDecision: i % 100, retentionCohortUsers: i % 60 });
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `20000 次调用耗时 ${ms}ms`);
});

/* ===================== P5 · RQ-98 兼容性与回归 ===================== */

test('P5 · RQ-98 指标名与可读下限常量稳定（看板文案依赖）', () => {
  assert.equal(RETENTION_MIN_SAMPLE, 30);
  assert.ok(ACQUISITION_CHANNELS.length >= 3);
  const n = summarizeNorthStar({ registeredUsers: 10, usersWithFirstDecision: 2 });
  assert.equal(n.current.metric, '首训完成率');
  assert.equal(n.formal.metric, '7 日留存率');
});

/* ===================== P0 · RQ-105 获客实验 ===================== */

test('P0 · RQ-105 按渠道给出注册数与首训完成率', () => {
  const rows = [
    { userId: 1, channel: 'community', registeredAt: '2026-10-20', firstDecisionAt: '2026-10-20T01:00:00Z' },
    { userId: 2, channel: 'community', registeredAt: '2026-10-20' },
    { userId: 3, channel: 'search', registeredAt: '2026-10-20', firstDecisionAt: '2026-10-20T02:00:00Z' },
  ];
  const a = summarizeAcquisition(rows);
  const community = a.channels.find((c) => c.channel === 'community');
  const search = a.channels.find((c) => c.channel === 'search');
  assert.equal(community.registered, 2);
  assert.equal(community.firstDecision, 1);
  assert.equal(community.firstTrainingRate, 50);
  assert.equal(search.firstTrainingRate, 100);
  assert.equal(a.total.registered, 3);
  assert.equal(a.total.firstDecision, 2);
});

test('P0 · RQ-105 本阶段只测首训完成率，目标为 2 周内 ≥30 个真实注册', () => {
  const a = summarizeAcquisition([]);
  assert.equal(a.target.registered, 30);
  assert.equal(a.target.withinDays, 14);
  assert.match(a.note, /只测/);
  assert.match(a.note, /不测留存/, 'N 不足时测留存只是噪声');
});

/* ===================== P1 · RQ-105 渠道口径 ===================== */

test('P1 · RQ-105 未知 / 缺失渠道归入 unknown，不污染渠道口径', () => {
  assert.equal(normalizeChannel('community'), 'community');
  assert.equal(normalizeChannel(' COMMUNITY '), 'community');
  assert.equal(normalizeChannel('weird-source'), UNKNOWN_CHANNEL);
  assert.equal(normalizeChannel(null), UNKNOWN_CHANNEL);
  assert.equal(normalizeChannel(''), UNKNOWN_CHANNEL);

  const a = summarizeAcquisition([{ userId: 1, channel: 'weird-source' }]);
  assert.equal(a.channels[0].channel, UNKNOWN_CHANNEL);
  assert.equal(a.channels.length, 1, '所有未知渠道应聚合为一条');
});

test('P1 · RQ-105 给出注册→首次决策的中位耗时（判断渠道带来的是不是「真来练的人」）', () => {
  const a = summarizeAcquisition([
    { userId: 1, channel: 'community', registeredAt: '2026-10-20T00:00:00Z', firstDecisionAt: '2026-10-20T00:00:30Z' },
    { userId: 2, channel: 'community', registeredAt: '2026-10-20T00:00:00Z', firstDecisionAt: '2026-10-20T00:01:30Z' },
  ]);
  const c = a.channels[0];
  assert.equal(c.medianSecToFirstDecision, 60);
});

/* ===================== P3 · RQ-105 边界与异常 ===================== */

test('P3 · RQ-105 空数据与脏入参不抛错且不产生 NaN', () => {
  for (const bad of [null, undefined, [], 'x']) {
    const a = summarizeAcquisition(bad);
    assert.equal(a.total.registered, 0);
    assert.equal(a.total.firstTrainingRate, null);
  }
  // 单条脏数据：仍计为一次注册，但渠道归 unknown、非法日期不被算作「已决策」
  const dirty = summarizeAcquisition([{ channel: null, registeredAt: 'bad-date', firstDecisionAt: 'bad-date' }]);
  assert.equal(dirty.total.registered, 1);
  assert.equal(dirty.channels[0].channel, UNKNOWN_CHANNEL);
  assert.equal(dirty.channels[0].firstDecision, 0, '非法日期不得被当作一次有效首训');
  const text = JSON.stringify(dirty);
  assert.ok(!text.includes('NaN'), '脏日期不得产出 NaN 耗时');
  assert.ok(!text.includes('Infinity'));
});

/* ===================== P4 · RQ-105 性能 ===================== */

test('P4 · RQ-105 20000 条注册记录的渠道聚合在预算内完成', () => {
  const rows = Array.from({ length: 20000 }, (_, i) => ({
    userId: i + 1,
    channel: ACQUISITION_CHANNELS[i % ACQUISITION_CHANNELS.length],
    registeredAt: '2026-10-20T00:00:00Z',
    firstDecisionAt: i % 4 === 0 ? '2026-10-20T00:00:40Z' : null,
  }));
  const t0 = Date.now();
  const a = summarizeAcquisition(rows);
  const ms = Date.now() - t0;
  assert.equal(a.total.registered, 20000);
  assert.ok(ms < 1500, `20000 条耗时 ${ms}ms`);
});

/* ===================== P5 · RQ-105 兼容性与回归 ===================== */

test('P5 · RQ-105 渠道按首训人数降序排列（可直接用于「哪个渠道有效」的结论）', () => {
  const a = summarizeAcquisition([
    { userId: 1, channel: 'search', firstDecisionAt: '2026-10-20' },
    { userId: 2, channel: 'community', firstDecisionAt: '2026-10-20' },
    { userId: 3, channel: 'community', firstDecisionAt: '2026-10-20' },
  ]);
  assert.equal(a.channels[0].channel, 'community', 'community 首训 2 人应排在前面');
});
