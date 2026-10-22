import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  generateScenarioBars,
  scoreAttempt,
  decisionQuality,
  gradeOf,
  buildHints,
  SCENARIO_DEFS,
} from '../../src/services/scenarioService.js';

// 剧本训练场（RQ-16 ~ RQ-19）
// P0：同一剧本每次进入的初始条件与行情必须完全一致 —— 这是剧本训练成立的前提

test('P0 mulberry32 对同一种子输出完全一致的序列', () => {
  const a = mulberry32(20261001);
  const b = mulberry32(20261001);
  const sa = [a(), a(), a(), a(), a()];
  const sb = [b(), b(), b(), b(), b()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, [mulberry32(20261002)(), 0, 0, 0, 0]);
});

test('P0 随机数落在 [0,1) 区间', () => {
  const r = mulberry32(7);
  for (let i = 0; i < 1000; i += 1) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

test('P0 同一剧本两次生成的行情序列完全一致（初始条件可复现）', () => {
  const def = SCENARIO_DEFS[0];
  const a = generateScenarioBars(def);
  const b = generateScenarioBars(def);
  assert.deepEqual(a, b);
});

test('P0 不同剧本的行情互不相同', () => {
  const a = generateScenarioBars(SCENARIO_DEFS[0]);
  const b = generateScenarioBars(SCENARIO_DEFS[1]);
  assert.notDeepEqual(a, b);
});

test('P1 bar 数量与涨跌停约束正确', () => {
  const bars = generateScenarioBars({ type: 'single_up', seed: 1, barCount: 30, startPrice: 20 });
  assert.equal(bars.length, 30);
  assert.equal(bars[0].seq, 1);
  for (let i = 1; i < bars.length; i += 1) {
    const p = bars[i].prices.SCENARIO;
    const prev = bars[i - 1].prices.SCENARIO.close;
    // 单根 bar 内价格不得超过 ±10%
    assert.ok(p.close <= prev * 1.1 + 1e-9, `第 ${i} 根超出涨停`);
    assert.ok(p.close >= prev * 0.9 - 1e-9, `第 ${i} 根超出跌停`);
    assert.ok(p.high >= p.low);
  }
});

test('P2 边界：barCount 非法值被夹紧到 [2,400]', () => {
  assert.equal(generateScenarioBars({ type: 'sideways', seed: 1, barCount: 0 }).length, 2);
  assert.equal(generateScenarioBars({ type: 'sideways', seed: 1, barCount: 99999 }).length, 400);
});

// ---------- RQ-18 评分 ----------
const DEF = SCENARIO_DEFS[0]; // single_up，maxTrades 4

test('P0 同一组操作两次评分结果完全一致（评分可复查）', () => {
  const trades = [
    { seq: 2, side: 'BUY', quantity: 1000 },
    { seq: 38, side: 'SELL', quantity: 1000 },
  ];
  const a = scoreAttempt({ def: DEF, trades });
  const b = scoreAttempt({ def: DEF, trades });
  assert.deepEqual(a, b);
});

test('P1 评分四维齐全且落在 0~100', () => {
  const r = scoreAttempt({
    def: DEF,
    trades: [
      { seq: 2, side: 'BUY', quantity: 1000 },
      { seq: 38, side: 'SELL', quantity: 1000 },
    ],
  });
  const b = r.score.breakdown;
  for (const v of [b.returnScore, b.drawdownScore, b.disciplineScore, b.decisionScore]) {
    assert.ok(v >= 0 && v <= 100, `${v} 越界`);
  }
  assert.ok(r.score.total >= 0 && r.score.total <= 100);
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(r.score.grade));
});

test('P1 评级边界与 total 严格对应', () => {
  assert.equal(gradeOf(95), 'S');
  assert.equal(gradeOf(85), 'A');
  assert.equal(gradeOf(75), 'B');
  assert.equal(gradeOf(65), 'C');
  assert.equal(gradeOf(59), 'D');
});

test('P1 超出交易次数上限被判定违规并扣纪律分', () => {
  const many = [];
  for (let i = 2; i < 30; i += 2) many.push({ seq: i, side: i % 4 === 0 ? 'SELL' : 'BUY', quantity: 100 });
  const r = scoreAttempt({ def: DEF, trades: many });
  assert.ok(r.metrics.tradeCount > 4);
  assert.ok(r.score.violations.some((v) => v.key === 'maxTrades'));
  assert.ok(r.score.breakdown.disciplineScore < 100);
  assert.equal(r.score.passed, false);
});

test('P1 全程未成交视为未完成关卡（不能靠“不动”混过）', () => {
  const r = scoreAttempt({ def: DEF, trades: [] });
  assert.equal(r.metrics.tradeCount, 0);
  assert.equal(r.score.passed, false);
  assert.ok(Number.isFinite(r.score.total));
  assert.ok(Array.isArray(r.hints));
  assert.ok(r.hints.length > 0);
});

test('P2 非法 trade 输入被清洗，不抛错', () => {
  const r = scoreAttempt({
    def: DEF,
    trades: [
      { seq: 'abc', side: 'BUY', quantity: 100 },
      { seq: 3, side: 'XXX', quantity: -5 },
      null,
    ],
  });
  assert.equal(r.metrics.tradeCount, 0);
});

// ---------- 决策质量 ----------
test('P1 买在最低点计 100 分，卖在最低点计 0 分', () => {
  const bars = [
    { seq: 1, prices: { SCENARIO: { high: 11, low: 10, close: 10 } } },
    { seq: 2, prices: { SCENARIO: { high: 11, low: 10, close: 10 } } },
  ];
  assert.equal(decisionQuality({ trades: [{ seq: 1, side: 'BUY' }], bars }), 100);
  assert.equal(decisionQuality({ trades: [{ seq: 2, side: 'SELL' }], bars }), 0);
});

test('P2 无成交时决策质量为 0，不返回 NaN', () => {
  assert.equal(decisionQuality({ trades: [], bars: [] }), 0);
});

// ---------- RQ-19 失败提示 ----------
test('P1 失败时给出指向具体 K 线的提示', () => {
  const bars = generateScenarioBars({ type: 'sharp_drop', seed: 42, barCount: 20, startPrice: 20 });
  const hint = buildHints({
    def: SCENARIO_DEFS[1],
    sim: { tradeCount: 0, rejected: [], trades: [] },
    bars,
    passed: false,
  });
  assert.ok(hint.length > 0);
  assert.match(hint[0].node, /K 线|未成交/);
  assert.ok(hint[0].detail.length > 0);
});

test('P2 bars 为空时提示列表不抛错', () => {
  assert.deepEqual(buildHints({ def: DEF, sim: { trades: [] }, bars: [], passed: false }), []);
});

// ---------- RQ-16 题库规模 ----------
test('P1 剧本题库不少于 8 关且难度/目标齐备', () => {
  assert.ok(SCENARIO_DEFS.length >= 8, `实际 ${SCENARIO_DEFS.length} 关`);
  for (const d of SCENARIO_DEFS) {
    assert.ok(d.goal && d.goal.length > 0, `${d.key} 缺训练目标`);
    assert.ok(['easy', 'medium', 'hard'].includes(d.difficulty));
    assert.ok(d.constraints.maxTrades > 0);
    assert.ok(d.constraints.maxDrawdownPct > 0);
  }
  const keys = new Set(SCENARIO_DEFS.map((d) => d.key));
  assert.equal(keys.size, SCENARIO_DEFS.length); // key 不可重复
});
