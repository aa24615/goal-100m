/**
 * RQ-95 小样本护栏 / RQ-97 可信度误差带 —— 单元测试
 *
 * 优先级模型：
 *   P0 核心主流程：N<30 不展示比率；误差带按 ±1.96σ/√n 计算
 *   P1 差异化功能：护栏动作、策略级措辞门槛、正负号不确定判定
 *   P3 边界与异常：0 笔 / 脏入参 / 极大样本
 *   P4 性能：大样本不退化
 *   P5 兼容性与回归：RQ-77 的 verdict 口径不倒退
 *
 * 两条硬约束（来自 v8）：
 *   - I-1 误差带是本次竞品检索中**唯一确认的全行业空白**；
 *   - 空页面正是护栏的价值，不得因为「页面太空」把门槛砍掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRatioGate,
  errorBandOf,
  stdDev,
  buildCheckup,
  RATIO_GUARD_THRESHOLD,
  BAND_Z,
  DEFAULT_SIGMA_R,
  SAMPLE_THRESHOLD,
} from '../../src/services/checkupService.js';

function rounds(n, { winEvery = 2, pnl = 100, fee = 5 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    sellId: i + 1,
    code: `6000${String(i % 10).padStart(2, '0')}`,
    status: 'closed',
    realizedPnl: i % winEvery === 0 ? pnl : -pnl,
    fee,
    holdDays: i % winEvery === 0 ? 2 : 9,
    closedAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))).toISOString(),
    sellPrice: 10 + (i % 5),
    quantity: 100,
  }));
}

/* ===================== P0 · RQ-95 小样本护栏 ===================== */

test('P0 · RQ-95 护栏门槛为 30 笔，29 与 30 分界正确', () => {
  assert.equal(RATIO_GUARD_THRESHOLD, 30);
  assert.equal(resolveRatioGate(29).showRatios, false);
  assert.equal(resolveRatioGate(30).showRatios, true);
  assert.equal(resolveRatioGate(30).remaining, 0);
  assert.equal(resolveRatioGate(12).remaining, 18);
});

test('P0 · RQ-95 N<30 时胜率 / 期望值R / 平均R / 排名全部关闭', () => {
  const g = resolveRatioGate(12);
  assert.equal(g.showRatios, false);
  assert.equal(g.showRanking, false, '小样本不参与排名展示');
  assert.ok(g.reason.includes('12'));
  assert.ok(g.action, '必须给出「继续积累样本」的动作，而不是留一片空白');
  assert.equal(g.action.path, '/blind');
});

test('P0 · RQ-95 buildCheckup 在 N<30 时 ratios 为 null（页面据此整块隐藏）', () => {
  const c = buildCheckup({ rounds: rounds(12) });
  assert.equal(c.ratios, null);
  assert.equal(c.ratioGate.showRatios, false);

  const ok = buildCheckup({ rounds: rounds(75) });
  assert.ok(ok.ratios, '过护栏后应给出比率');
  assert.ok(ok.ratios.winRate > 0 && ok.ratios.winRate < 100, '胜率应为合法百分比');
  assert.ok(ok.ratios.bandR > 0, '比率必须连同误差带一起给出，否则又变成满屏确定数字');
});

test('P0 · RQ-95 策略级措辞门槛沿用 200 笔档，比 30 笔严格得多', () => {
  assert.equal(resolveRatioGate(60).showStrategyLanguage, false, '60 笔不得出现策略级措辞');
  assert.equal(resolveRatioGate(199).showStrategyLanguage, false);
  assert.equal(resolveRatioGate(200).showStrategyLanguage, true);
});

/* ===================== P1 · RQ-95 护栏动作 ===================== */

test('P1 · RQ-95 过护栏后不再显示护栏动作', () => {
  assert.equal(resolveRatioGate(30).action, null);
  assert.match(resolveRatioGate(30).reason, /已达 30 笔护栏/);
});

/* ===================== P3 · RQ-95 边界与异常 ===================== */

test('P3 · RQ-95 脏入参按 0 处理，不抛错不产生 NaN', () => {
  for (const bad of [null, undefined, NaN, -5, 1.9, '80', 'abc', {}]) {
    const g = resolveRatioGate(bad);
    assert.equal(typeof g.showRatios, 'boolean', `入参 ${String(bad)} 应返回布尔`);
    assert.ok(Number.isFinite(g.remaining));
  }
  assert.equal(resolveRatioGate('80').showRatios, true, '字符串数字按数字解析');
  assert.equal(resolveRatioGate(-5).showRatios, false, '负数归零');
  assert.equal(resolveRatioGate(29.9).showRatios, false, '小数向下取整');
});

/* ===================== P4 · RQ-95 性能 ===================== */

test('P4 · RQ-95 护栏判定连续 20000 次调用不退化', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20000; i += 1) resolveRatioGate(i % 300);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `20000 次调用耗时 ${ms}ms`);
});

/* ===================== P5 · RQ-95 兼容性与回归 ===================== */

test('P5 · RQ-95 护栏不倒退 RQ-77：未过 50 笔仍然不给 verdict', () => {
  const c = buildCheckup({ rounds: rounds(35) });
  assert.equal(c.ratioGate.showRatios, true, '35 笔已过 30 笔护栏');
  assert.equal(c.sufficient, false, '但 RQ-77 的 50 笔门槛未过');
  assert.equal(c.verdict, null, 'RQ-77 硬约束不因新增护栏而失效');
  assert.equal(c.threshold, SAMPLE_THRESHOLD);
});

/* ===================== P0 · RQ-97 误差带 ===================== */

test('P0 · RQ-97 误差带口径为 ±1.96σ/√n', () => {
  assert.equal(BAND_Z, 1.96);
  // 行业口径校验：30 笔 ≈ ±0.54R、100 笔 ≈ ±0.29R（σ=1.5R）
  assert.equal(errorBandOf({ sampleSize: 30 }).bandR, 0.54);
  assert.equal(errorBandOf({ sampleSize: 100 }).bandR, 0.29);
  assert.equal(DEFAULT_SIGMA_R, 1.5);
});

test('P0 · RQ-97 30 笔明确告知「连正负号都不能确定」', () => {
  const b = errorBandOf({ sampleSize: 30, expectancyR: 0.3 });
  assert.equal(b.signUncertain, true, '误差 ±0.54R 大于期望值 0.3R，符号不确定');
  assert.match(b.text, /连正负号都不能确定/);
  assert.match(b.cannot, /不能拿它判断策略是否赚钱/);
});

test('P0 · RQ-97 样本增大后误差带收敛，方向可采信', () => {
  const small = errorBandOf({ sampleSize: 30 });
  const large = errorBandOf({ sampleSize: 300 });
  assert.ok(large.bandR < small.bandR, '样本越大误差带越窄');
  const b = errorBandOf({ sampleSize: 300, expectancyR: 0.5 });
  assert.equal(b.signUncertain, false);
  assert.match(b.text, /方向可采信/);
});

test('P0 · RQ-97 每档体检单都带上误差带与「不能拿它做什么」', () => {
  const c = buildCheckup({ rounds: rounds(60) });
  assert.ok(c.errorBand, '体检单必须带误差带');
  assert.ok(c.errorBand.bandR > 0);
  assert.ok(c.errorBand.text.length > 0);
  assert.ok(c.errorBand.cannot.length > 0);
  assert.equal(c.errorBand.n, 60);
});

/* ===================== P1 · RQ-97 实测标准差 ===================== */

test('P1 · RQ-97 有实测 R 序列时改用实测 σ，而非永远挂默认常数', () => {
  const sigma = stdDev([1, -1, 2, -2, 0.5, -0.5]);
  assert.ok(sigma > 0);
  const withMeasured = errorBandOf({ sampleSize: 100, sigma });
  const withDefault = errorBandOf({ sampleSize: 100 });
  assert.notEqual(withMeasured.bandR, withDefault.bandR);
  assert.equal(withMeasured.sigma, Math.round(sigma * 100) / 100);
});

test('P1 · RQ-97 误差带给出置信区间上下界', () => {
  const b = errorBandOf({ sampleSize: 100, expectancyR: 0.5, sigma: 1.5 });
  assert.ok(b.low < 0.5 && b.high > 0.5);
  assert.equal(b.low, Math.round((0.5 - 0.294) * 100) / 100);
});

/* ===================== P3 · RQ-97 边界与异常 ===================== */

test('P3 · RQ-97 0 笔时误差带为 null 数值但不产生 Infinity', () => {
  const b = errorBandOf({ sampleSize: 0 });
  assert.equal(b.bandR, null);
  assert.equal(b.low, null);
  assert.equal(b.high, null);
  assert.equal(b.signUncertain, true);
  const text = JSON.stringify(b);
  assert.ok(!text.includes('NaN'));
  assert.ok(!text.includes('Infinity'));
});

test('P3 · RQ-97 脏入参不抛错', () => {
  for (const bad of [null, undefined, {}, { sampleSize: 'abc' }, { sampleSize: -10 }, { sampleSize: 1e9 }]) {
    const b = errorBandOf(bad);
    assert.ok(b.text, `入参 ${String(bad)} 应返回文案`);
    assert.ok(b.cannot);
  }
  assert.doesNotThrow(() => errorBandOf());
});

test('P3 · RQ-97 标准差样本不足 2 个时返回 null 而不是 0', () => {
  assert.equal(stdDev([]), null);
  assert.equal(stdDev([1]), null);
  assert.equal(stdDev(null), null);
  assert.equal(stdDev([2, 2, 2]), 0, '无波动时标准差为 0');
});

/* ===================== P4 · RQ-97 性能 ===================== */

test('P4 · RQ-97 误差带连续 20000 次计算不退化', () => {
  const t0 = Date.now();
  for (let i = 1; i <= 20000; i += 1) errorBandOf({ sampleSize: (i % 500) + 1 });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `20000 次耗时 ${ms}ms`);
});

/* ===================== P5 · RQ-97 兼容性与回归 ===================== */

test('P5 · RQ-97 分档结果自带误差带（resolveTier 新字段不破坏旧调用方）', () => {
  const c = buildCheckup({ rounds: rounds(120) });
  assert.ok(c.tier.band, 'resolveTier 应带 band 字段');
  assert.equal(c.tier.band.n, 120);
  // 旧字段必须仍在
  assert.equal(c.tier.sufficient, true);
  assert.ok(typeof c.tier.remaining === 'number');
  assert.ok(typeof c.tier.progressPercent === 'number');
});

test('P5 · RQ-97 体检单整体序列化后不含 NaN / Infinity', () => {
  for (const n of [0, 1, 12, 29, 30, 75, 200, 1000]) {
    const text = JSON.stringify(buildCheckup({ rounds: rounds(n) }));
    assert.ok(!text.includes('NaN'), `${n} 笔出现 NaN`);
    assert.ok(!text.includes('Infinity'), `${n} 笔出现 Infinity`);
  }
});
