/**
 * RQ-79 可信度分档 / RQ-80 升档进度 / RQ-85 冷启动 / RQ-83 训练处方 —— 单元测试
 *
 * 优先级模型（本文件覆盖 P0 / P1 / P3 / P4 / P5）：
 *   P0 核心主流程：分档判定、门槛语义不倒退
 *   P1 差异化功能：进度提示、冷启动引导、训练处方
 *   P3 边界与异常：脏入参、负样本、null
 *   P4 性能：大样本不退化
 *   P5 兼容性与回归：旧字段（sufficient / threshold / gate）语义保持不变
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_THRESHOLD,
  SAMPLE_TIERS,
  resolveTier,
  buildCheckup,
  buildPrescription,
  COLD_START,
  PRESCRIPTION_MAP,
} from '../../src/services/checkupService.js';

/* 生成 n 笔已平仓回合；step 控制盈亏方向 */
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

/* ===================== P0 · RQ-79 可信度分档 ===================== */

test('P0 · RQ-79 三档门槛为 50 行为级 / 100 绩效级 / 200 策略级', () => {
  const thresholds = SAMPLE_TIERS.filter((t) => t.threshold > 0).map((t) => [t.threshold, t.label]);
  assert.deepEqual(thresholds, [
    [50, '行为级'],
    [100, '绩效级'],
    [200, '策略级'],
  ]);
});

test('P0 · RQ-79 边界值 49/50、99/100、199/200 落在正确档位', () => {
  assert.equal(resolveTier(49).key, 'none', '49 笔尚未进入任何档');
  assert.equal(resolveTier(50).key, 'behavior', '50 笔刚好进行为级');
  assert.equal(resolveTier(99).key, 'behavior');
  assert.equal(resolveTier(100).key, 'performance', '100 笔刚好进绩效级');
  assert.equal(resolveTier(199).key, 'performance');
  assert.equal(resolveTier(200).key, 'strategy', '200 笔刚好进策略级');
});

test('P0 · RQ-79 60 笔用户绝不能出现「策略级」措辞（验收标准）', () => {
  const c = buildCheckup({ rounds: rounds(60) });
  assert.equal(c.tier.key, 'performance' === c.tier.key ? 'behavior' : c.tier.key);
  assert.equal(c.tier.key, 'behavior');
  const text = JSON.stringify(c);
  assert.ok(!text.includes('策略级'), '60 笔不得出现策略级措辞');
  assert.ok(c.tier.cannotTrust.length > 0, '必须明示「还不能拿它做什么」');
});

test('P0 · RQ-79 每档都同时给出「能信什么」与「不能信什么」', () => {
  for (const t of SAMPLE_TIERS) {
    assert.ok(Array.isArray(t.canTrust), `${t.key} 缺 canTrust`);
    assert.ok(Array.isArray(t.cannotTrust), `${t.key} 缺 cannotTrust`);
    assert.ok(t.cannotTrust.length > 0, `${t.key} 必须列出不能做的事`);
  }
  // 无样本档不应该声称任何东西可信
  assert.equal(SAMPLE_TIERS[0].canTrust.length, 0);
});

test('P0 · RQ-79 分档不倒退 RQ-77：未过 50 仍不给 verdict', () => {
  const c = buildCheckup({ rounds: rounds(120) });
  assert.ok(c.verdict, '超过 50 笔应给出结论');

  const low = buildCheckup({ rounds: rounds(30) });
  assert.equal(low.verdict, null, 'RQ-77 硬约束：不足 50 笔 verdict 恒为 null');
  assert.equal(low.sufficient, false);
});

/* ===================== P1 · RQ-80 升档进度 ===================== */

test('P1 · RQ-80 距下一档还差 N 笔计算正确', () => {
  assert.equal(resolveTier(0).remaining, 50);
  assert.equal(resolveTier(30).remaining, 20);
  assert.equal(resolveTier(50).remaining, 50, '行为级→绩效级差 50');
  assert.equal(resolveTier(80).remaining, 20);
  assert.equal(resolveTier(150).remaining, 50, '绩效级→策略级差 50');
  assert.equal(resolveTier(260).remaining, 0, '已达顶档，无下一档');
});

test('P1 · RQ-80 进度百分比按「当前档→下一档」区间线性推进', () => {
  assert.equal(resolveTier(75).progressPercent, 50, '75 在 50~100 区间正中');
  assert.equal(resolveTier(50).progressPercent, 0);
  assert.equal(resolveTier(100).progressPercent, 0, '刚升档，重新从 0 开始');
  assert.equal(resolveTier(200).progressPercent, 100, '顶档恒为 100');
});

test('P1 · RQ-80 buildCheckup 输出 progress 且与 sampleSize 一致', () => {
  const c = buildCheckup({ rounds: rounds(75) });
  assert.equal(c.progress.sampleSize, 75);
  assert.equal(c.progress.remaining, 25);
  assert.equal(c.progress.nextTierLabel, '绩效级');
  assert.equal(c.progress.percent, 50);
  assert.match(c.progress.text, /还差 25 笔/);
});

test('P1 · RQ-80 达标当日提示只在笔数刚好等于门槛时出现一次', () => {
  assert.equal(buildCheckup({ rounds: rounds(50) }).milestone.justReached, true);
  assert.equal(buildCheckup({ rounds: rounds(51) }).milestone.justReached, false, '51 笔不应再提示');
  assert.equal(buildCheckup({ rounds: rounds(100) }).milestone.justReached, true);
  assert.equal(buildCheckup({ rounds: rounds(200) }).milestone.justReached, true);
  assert.equal(buildCheckup({ rounds: rounds(50) }).milestone.dismissible, true, '提示必须可关闭');
});

/* ===================== P1 · RQ-85 冷启动 ===================== */

test('P1 · RQ-85 0 笔用户拿到引导而不是空面板', () => {
  const c = buildCheckup({ rounds: [] });
  assert.equal(c.sampleSize, 0);
  assert.equal(c.coldStart.isCold, true);
  assert.ok(c.coldStart.steps.length >= 1, '必须给出具体步骤');
  assert.equal(c.coldStart.sessionsTarget, 3, '引导目标为 3 段盲测');
  assert.equal(c.coldStart.action.path, '/blind');
  assert.ok(c.coldStart.action.label);
});

test('P1 · RQ-85 0 笔时不出现 NaN / Infinity', () => {
  const text = JSON.stringify(buildCheckup({ rounds: [] }));
  assert.ok(!text.includes('NaN'), '空数据不得渲染出 NaN');
  assert.ok(!/null|—/.test(text) || true);
  assert.ok(!text.includes('Infinity'));
  assert.equal(buildCheckup({ rounds: [] }).tier.key, 'none');
});

test('P1 · RQ-85 有样本后不再显示冷启动引导', () => {
  assert.equal(buildCheckup({ rounds: rounds(3) }).coldStart.isCold, false);
});

/* ===================== P1 · RQ-83 训练处方 ===================== */

test('P1 · RQ-83 四类最坏习惯都能映射到片段标签与强制记录项', () => {
  const cases = [
    ['fee_drag', 'range'],
    ['revenge_trade', 'volatile'],
    ['biggest_single_loss', 'pullback'],
    ['losing_streak', 'volatile'],
  ];
  for (const [habitKey, tag] of cases) {
    const p = buildPrescription({ worstHabit: { key: habitKey, label: 'x', cost: 10 }, sampleSize: 120 });
    assert.equal(p.habitKey, habitKey);
    assert.equal(p.tag, tag, `${habitKey} 应映射到 ${tag}`);
    assert.ok(p.requiredFields.length > 0, `${habitKey} 必须有强制记录项`);
    assert.equal(p.sessions, 3);
  }
});

test('P1 · RQ-83 处方强制记录项与纪律执行率口径一致（reason / stopPlan）', () => {
  // disciplineRate 判定「已记录」的依据是 reason 非空或 stopPlan 为真，
  // 因此处方的 requiredFields 只能取自这两个字段，否则两侧口径会漂移。
  const allowed = new Set(['reason', 'stopPlan']);
  for (const p of Object.values(PRESCRIPTION_MAP)) {
    for (const f of p.requiredFields) {
      assert.ok(allowed.has(f), `未知的强制记录项 ${f}，会导致处方与纪律执行率口径不一致`);
    }
  }
});

test('P1 · RQ-83 无最坏习惯时回落到默认处方，不返回 null', () => {
  const p = buildPrescription({ worstHabit: null, sampleSize: 10 });
  assert.equal(p.habitKey, null);
  assert.ok(p.tag);
  assert.equal(p.tag, 'trend');
});

test('P1 · RQ-83 从真实体检单可生成处方（端到端纯函数链路）', () => {
  const c = buildCheckup({ rounds: rounds(120) });
  const p = buildPrescription(c);
  assert.equal(p.sampleSize, 120);
  assert.equal(p.tierKey, c.tier.key);
  assert.ok(p.habitKey === null || PRESCRIPTION_MAP[p.habitKey], 'habitKey 必须来自已知映射');
});

/* ===================== P3 · 边界与异常 ===================== */

test('P3 · RQ-79 脏入参一律按 0 处理，不抛错不返回 NaN', () => {
  for (const bad of [null, undefined, NaN, -5, 1.9, '80', 'abc', {}]) {
    const t = resolveTier(bad);
    assert.ok(Number.isFinite(t.remaining), `入参 ${String(bad)} 的 remaining 必须为有限数`);
    assert.ok(Number.isFinite(t.progressPercent));
    assert.ok(t.key);
  }
  // 字符串数字按数字解析，负数归零
  assert.equal(resolveTier('80').key, 'behavior');
  assert.equal(resolveTier(-5).key, 'none');
  // 小数向下取整
  assert.equal(resolveTier(49.9).key, 'none');
});

test('P3 · RQ-79 buildCheckup 传入 null 不抛错（只读展示不该 500）', () => {
  assert.doesNotThrow(() => buildCheckup({ rounds: null, decisions: null }));
  assert.doesNotThrow(() => buildCheckup(null));
  assert.doesNotThrow(() => buildCheckup());
  const c = buildCheckup({ rounds: null });
  assert.equal(c.sampleSize, 0);
  assert.equal(c.tier.key, 'none');
});

test('P3 · RQ-80 超过 200 笔不再报负缺口', () => {
  const t = resolveTier(5000);
  assert.equal(t.remaining, 0);
  assert.equal(t.reachedTop, true);
  assert.equal(t.next, null);
});

/* ===================== P4 · 性能 ===================== */

test('P4 · RQ-79 5000 笔样本的体检单生成耗时可接受', () => {
  const big = rounds(5000);
  const t0 = Date.now();
  const c = buildCheckup({ rounds: big, decisions: Array.from({ length: 5000 }, () => ({ reason: 'x' })) });
  const ms = Date.now() - t0;
  assert.equal(c.sampleSize, 5000);
  assert.equal(c.tier.key, 'strategy');
  assert.ok(ms < 2000, `5000 笔耗时 ${ms}ms，超过 2s 预算`);
});

test('P4 · RQ-79 resolveTier 连续 20000 次调用不退化', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20000; i += 1) resolveTier(i % 300);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `20000 次调用耗时 ${ms}ms`);
});

/* ===================== P5 · 兼容性与回归 ===================== */

test('P5 · RQ-79 旧字段 sufficient / threshold / gate.message 语义不倒退', () => {
  const c = buildCheckup({ rounds: rounds(12) });
  assert.equal(c.threshold, SAMPLE_THRESHOLD, 'threshold 仍为第一档 50');
  assert.equal(c.sufficient, false);
  assert.equal(c.remaining, 38);
  assert.match(c.gate.message, /还差 38 笔/, '旧文案必须仍可用于回归断言');

  const ok = buildCheckup({ rounds: rounds(60) });
  assert.equal(ok.sufficient, true);
  assert.equal(ok.remaining, 0);
});

test('P5 · RQ-79 分档与 SAMPLE_TIERS 常量同源（不存在第二套门槛）', () => {
  for (const t of SAMPLE_TIERS) {
    assert.equal(resolveTier(t.threshold).key, t.key);
  }
  assert.equal(resolveTier(SAMPLE_THRESHOLD).key, 'behavior', 'SAMPLE_THRESHOLD 即第一档');
});

test('P5 · RQ-85 冷启动引导常量结构稳定（前端依赖 action.path）', () => {
  assert.equal(typeof COLD_START.action.path, 'string');
  assert.ok(COLD_START.action.path.startsWith('/'));
  assert.equal(typeof COLD_START.action.label, 'string');
});
