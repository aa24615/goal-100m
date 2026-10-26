/**
 * RQ-99 训练成绩卡 / RQ-102 训练与真实规则账户同源 —— 单元测试
 *
 * 优先级模型：
 *   P0 核心主流程：成绩卡可生成并可复制、规则同源可校验
 *   P1 差异化功能：档位缺口与体检单同源、落单计划
 *   P3 边界与异常：null 入参、未揭示标的、规则缺失
 *   P4 性能：大批量不退化
 *   P5 兼容性与回归：合规硬约束（不承诺奖励）、规则清单稳定
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreCard } from '../../src/services/scoreCardService.js';
import {
  RULES_MANIFEST,
  MANIFEST_KEYS,
  checkRuleParity,
  planAccountSync,
} from '../../src/services/ruleParityService.js';

const SESSION = {
  id: 42,
  alias: '标的 #7F3A',
  stock_code: '600519',
  stock_name: '贵州茅台',
  status: 'FINISHED',
  segment_tag: 'trend',
  granularity: 'day',
};

const SCORE = {
  returnPct: 3.25,
  maxDrawdown: 8.1,
  tradeCount: 4,
  decisionPoints: 6,
  disciplineRate: 83.33,
  disclaimer: '模拟训练成绩基于真实历史行情，不构成投资建议，不承诺任何收益。',
};

/* ===================== P0 · RQ-99 成绩卡主流程 ===================== */

test('P0 · RQ-99 成绩卡包含「做了什么 / 纪律执行率 / 样本贡献 / 距下一档」四要素', () => {
  const card = buildScoreCard({ session: SESSION, score: SCORE, sampleSize: 60 });
  const text = card.text;
  assert.match(text, /贵州茅台/, '做了什么：揭示后的标的');
  assert.match(text, /纪律执行率：83\.33%/, '纪律执行率');
  assert.match(text, /累计样本：60 笔/, '样本贡献');
  assert.match(text, /距下一档/, '距下一档还差多少');
  assert.equal(card.copyable, true);
});

test('P0 · RQ-99 档位与缺口与体检单同源（同一份 resolveTier）', () => {
  const card = buildScoreCard({ session: SESSION, score: SCORE, sampleSize: 60 });
  assert.equal(card.tier.key, 'behavior', '60 笔仍是行为级，不得升为策略级');
  assert.equal(card.tier.remaining, 40, '距绩效级还差 40 笔');
  assert.equal(card.tier.nextLabel, '绩效级');
  assert.match(card.text, /还差 40 笔/);
});

test('P0 · RQ-99 可复制为纯文本（不依赖截图与登录态）', () => {
  const card = buildScoreCard({ session: SESSION, score: SCORE, sampleSize: 120 });
  assert.equal(typeof card.text, 'string');
  assert.ok(card.text.length > 20);
  assert.ok(card.text.split('\n').length >= 6, '文本应为多行卡片');
  assert.ok(card.lines.length >= 5);
});

/* ===================== P1 · RQ-99 差异化 ===================== */

test('P1 · RQ-99 训练中（未揭示）不暴露标的代码，只显示代号', () => {
  const card = buildScoreCard({
    session: { ...SESSION, status: 'RUNNING' },
    score: SCORE,
    sampleSize: 0,
  });
  assert.match(card.text, /标的 #7F3A/);
  assert.ok(!card.text.includes('600519'), '未揭示时成绩卡不得含真实代码');
  assert.ok(!card.text.includes('贵州茅台'));
});

test('P1 · RQ-99 样本未过 30 笔护栏时不给出比率类结论', () => {
  const card = buildScoreCard({ session: SESSION, score: SCORE, sampleSize: 12 });
  assert.match(card.text, /不给出胜率 \/ 期望值类结论/);
  assert.ok(!/\d+(\.\d+)?%/.test(card.lines.find((l) => l.includes('胜率')) || ''));
});

/* ===================== P3 · RQ-99 边界与异常 ===================== */

test('P3 · RQ-99 null / 脏入参降级为可读文案，不抛错不产生 NaN', () => {
  for (const bad of [null, undefined, {}, { session: null, score: null }]) {
    const card = buildScoreCard(bad);
    assert.ok(card.text, `入参 ${String(bad)} 应返回文本`);
    assert.ok(card.lines.length >= 5);
    assert.ok(!card.text.includes('NaN'));
    assert.ok(!card.text.includes('Infinity'));
    assert.ok(!card.text.includes('undefined'));
  }
});

test('P3 · RQ-99 成绩缺失（未完成训练）时用「—」占位而不是 0', () => {
  const card = buildScoreCard({ session: { ...SESSION, status: 'RUNNING' }, score: {}, sampleSize: 0 });
  assert.match(card.text, /收益率：—/);
  assert.match(card.text, /纪律执行率：未生成/);
});

/* ===================== P4 · RQ-99 性能 ===================== */

test('P4 · RQ-99 连续 10000 次成绩卡生成在预算内完成', () => {
  const t0 = Date.now();
  for (let i = 0; i < 10000; i += 1) {
    buildScoreCard({ session: SESSION, score: SCORE, sampleSize: i % 300 });
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `10000 次耗时 ${ms}ms`);
});

/* ===================== P5 · RQ-99 兼容性与回归 ===================== */

test('P5 · RQ-99 成绩卡不承诺任何实物或现金奖励（合规硬约束）', () => {
  const card = buildScoreCard({ session: SESSION, score: SCORE, sampleSize: 60 });
  for (const word of ['奖励', '现金', '红包', '提现', '礼品']) {
    assert.ok(!card.text.includes(word), `成绩卡不得出现「${word}」`);
  }
  assert.match(card.disclaimer, /不承诺任何收益/);
});

/* ===================== P0 · RQ-102 规则同源 ===================== */

test('P0 · RQ-102 规则清单覆盖 T+1 / 涨跌停 / 停牌 / 费用 / 最小单位', () => {
  const keys = MANIFEST_KEYS;
  for (const k of ['t1', 'limit', 'halt', 'fee', 'lot']) {
    assert.ok(keys.includes(k), `规则清单缺 ${k}`);
  }
  for (const r of RULES_MANIFEST) {
    assert.ok(r.label && r.desc && r.source, `${r.key} 缺标签/说明/来源`);
  }
});

test('P0 · RQ-102 训练侧与账户侧规则一致时判定为同源', () => {
  const p = checkRuleParity({ trainingRules: MANIFEST_KEYS, accountRules: MANIFEST_KEYS });
  assert.equal(p.consistent, true);
  assert.equal(p.missingInAccount.length, 0);
  assert.equal(p.missingInTraining.length, 0);
  assert.match(p.summary, /共用同一套规则/);
});

test('P0 · RQ-102 任一侧缺规则即判定为不同源（不允许悄悄放行）', () => {
  const p = checkRuleParity({ trainingRules: MANIFEST_KEYS, accountRules: ['t1', 'fee'] });
  assert.equal(p.consistent, false);
  assert.deepEqual(p.missingInAccount.sort(), ['halt', 'limit', 'lot']);
  assert.match(p.summary, /规则不一致/);
});

/* ===================== P1 · RQ-102 落单计划 ===================== */

test('P1 · RQ-102 已结束的训练可生成落单计划，且按真实行情重定价', () => {
  const plan = planAccountSync({
    session: SESSION,
    orders: [{ seq: 5, stock_code: '600519', stock_name: '贵州茅台', side: 'BUY', quantity: 100 }],
  });
  assert.equal(plan.eligible, true);
  assert.equal(plan.blockedReason, null);
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].repricedAtMarket, true, '历史价格不能直接搬进今天的账户');
  assert.deepEqual(plan.orders[0].appliedRules, MANIFEST_KEYS);
});

test('P1 · RQ-102 计划附带规则同源校验结果', () => {
  const plan = planAccountSync({ session: SESSION, orders: [] });
  assert.equal(plan.parity.consistent, true);
  assert.ok(plan.note.includes('不直接写账户'));
});

/* ===================== P3 · RQ-102 边界与异常 ===================== */

test('P3 · RQ-102 训练未结束时禁止生成计划（落单会暴露标的，破坏双盲）', () => {
  const plan = planAccountSync({ session: { ...SESSION, status: 'RUNNING' }, orders: [{ seq: 1 }] });
  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.orders, []);
  assert.match(plan.blockedReason, /破坏双盲/);
});

test('P3 · RQ-102 脏入参不抛错', () => {
  for (const bad of [null, undefined, {}, { session: null, orders: null }]) {
    assert.doesNotThrow(() => planAccountSync(bad));
    assert.doesNotThrow(() => checkRuleParity(bad));
  }
  const p = checkRuleParity({ trainingRules: 't1', accountRules: 123 });
  assert.equal(typeof p.consistent, 'boolean');
});

/* ===================== P5 · RQ-102 兼容性与回归 ===================== */

test('P5 · RQ-102 规则 key 稳定（前端 RULES_MANIFEST 渲染依赖）', () => {
  assert.deepEqual(MANIFEST_KEYS, ['t1', 'limit', 'halt', 'fee', 'lot']);
  assert.equal(RULES_MANIFEST.length, 5);
});
