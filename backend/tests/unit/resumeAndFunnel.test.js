/**
 * RQ-91 训练会话持久化与断点续做 / RQ-96 训练漏斗埋点 —— 单元测试
 *
 * 优先级模型：
 *   P0 核心主流程：断点提示可生成、漏斗四步可定位断点
 *   P1 差异化功能：进度百分比、转化率、耗时中位数
 *   P3 边界与异常：null / 脏数据 / 游标越界 / 已结束会话
 *   P4 性能：大量会话不退化
 *   P5 兼容性与回归：步骤 key 与文案口径稳定，不因重构漂移
 *
 * 背景：v8 实地复核发现「开始了 4 次、决策 0 次、表里 0 行」，
 * 而当时根本答不出「断在第几步」。这两个需求就是为了让这件事**可被问、可被答**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeHint } from '../../src/services/blindService.js';
import {
  summarizeFunnel,
  FUNNEL_STEPS,
  FIRST_DECISION_BUDGET_SEC,
} from '../../src/services/trainingFunnelService.js';

const T0 = '2026-10-20T02:00:00.000Z';

/* ===================== P0 · RQ-91 断点提示主流程 ===================== */

test('P0 · RQ-91 未结束会话给出「上次停在第 N 根」提示', () => {
  const s = { id: 7, start_seq: 100, end_seq: 159, cursor_seq: 119, status: 'RUNNING', alias: '标的 #00FF' };
  const h = buildResumeHint(s);
  assert.equal(h.resumable, true);
  assert.equal(h.cursorIndex, 20, 'cursor_seq 119 - start 100 + 1 = 第 20 根');
  assert.equal(h.totalBars, 60);
  // 验收标准原文的口径
  assert.match(h.text, /上次停在第 20 根/);
  assert.equal(h.sessionId, 7);
  assert.equal(h.alias, '标的 #00FF');
});

test('P0 · RQ-91 第 1 根（刚开始就走）也给出合法提示', () => {
  const h = buildResumeHint({ id: 1, start_seq: 10, end_seq: 69, cursor_seq: 10, status: 'RUNNING' });
  assert.equal(h.resumable, true);
  assert.equal(h.cursorIndex, 1);
  assert.match(h.text, /上次停在第 1 根/);
});

/* ===================== P1 · RQ-91 续做进度 ===================== */

test('P1 · RQ-91 进度百分比按 游标 / 总根数 计算', () => {
  const h = buildResumeHint({ id: 2, start_seq: 0, end_seq: 99, cursor_seq: 49, status: 'RUNNING' });
  assert.equal(h.cursorIndex, 50);
  assert.equal(h.totalBars, 100);
  assert.equal(h.percent, 50);
});

test('P1 · RQ-91 同时给出「继续」与「放弃」两个出口', () => {
  const h = buildResumeHint({ id: 3, start_seq: 0, end_seq: 59, cursor_seq: 30, status: 'RUNNING' });
  assert.ok(h.actions, '必须给出可点击出口');
  assert.match(h.actions.resume.path, /session=3/);
  assert.ok(h.actions.abandon.label);
  assert.match(h.actions.abandon.path, /abandon=3/);
});

/* ===================== P3 · RQ-91 边界与异常 ===================== */

test('P3 · RQ-91 null / 空入参降级为「没有可续做的训练」，不抛错', () => {
  for (const bad of [null, undefined, {}, []]) {
    const h = buildResumeHint(bad);
    assert.equal(h.resumable, false, `入参 ${String(bad)} 不应产生可续做提示`);
    assert.ok(h.reason);
  }
});

test('P3 · RQ-91 已结束会话不再作为续做目标', () => {
  const h = buildResumeHint({ id: 4, start_seq: 0, end_seq: 59, cursor_seq: 59, status: 'FINISHED' });
  assert.equal(h.resumable, false);
  assert.match(h.reason, /已结束/);
});

test('P3 · RQ-91 脏数据（NaN / 游标越界）夹到合法区间，不渲染出负数', () => {
  const bad = buildResumeHint({ id: 5, start_seq: NaN, end_seq: null, cursor_seq: 'x', status: 'RUNNING' });
  assert.equal(bad.resumable, false);

  // 游标越界（比 end 还大）：夹紧到最后一根，而不是显示「第 999 根」
  const over = buildResumeHint({ id: 6, start_seq: 0, end_seq: 59, cursor_seq: 999, status: 'RUNNING' });
  assert.equal(over.cursorIndex, 60);
  assert.equal(over.totalBars, 60);
  assert.ok(over.cursorIndex <= over.totalBars);

  // 游标早于起点：夹紧到第 1 根
  const under = buildResumeHint({ id: 7, start_seq: 100, end_seq: 159, cursor_seq: 0, status: 'RUNNING' });
  assert.equal(under.cursorIndex, 1);
});

/* ===================== P5 · RQ-91 兼容性与回归 ===================== */

test('P5 · RQ-91 提示文案前缀稳定（前端 RESUME_HINT_PREFIX 依赖它）', () => {
  const h = buildResumeHint({ id: 8, start_seq: 0, end_seq: 59, cursor_seq: 9, status: 'RUNNING' });
  assert.ok(h.text.startsWith('上次停在第'));
  assert.match(h.text, /可以继续/);
});

/* ===================== P0 · RQ-96 训练漏斗 ===================== */

test('P0 · RQ-96 四步顺序为 开始 → 首次决策 → 持续决策 → 完成', () => {
  assert.deepEqual(
    FUNNEL_STEPS.map((s) => s.key),
    ['start', 'first_decision', 'mid_decision', 'finish']
  );
});

test('P0 · RQ-96 能定位每一次训练断在第几步（4 次开始 / 1 次决策的现场还原）', () => {
  const rows = [
    { sessionId: 1, decisions: 0 },
    { sessionId: 2, decisions: 0 },
    { sessionId: 3, decisions: 0 },
    { sessionId: 4, decisions: 1 },
  ];
  const f = summarizeFunnel(rows);
  // 分步计数：到达某一步的会话数
  assert.equal(f.steps[0].count, 4, '4 次开始');
  assert.equal(f.steps[1].count, 1, '只有 1 次走到首次决策');
  assert.equal(f.steps[2].count, 0);
  assert.equal(f.steps[3].count, 0);
  // 断点分布：3 次卡在「首次决策」
  const stuck = f.breakpoints.find((b) => b.key === 'first_decision');
  assert.equal(stuck.stuck, 3, '3 次会话的断点是首次决策');
  assert.equal(f.sessions[0].breakpoint, 'first_decision');
});

test('P0 · RQ-96 已完成会话没有断点', () => {
  const f = summarizeFunnel([
    { sessionId: 1, startedAt: T0, finishedAt: '2026-10-20T02:05:00.000Z', decisions: 6 },
  ]);
  assert.equal(f.sessions[0].reached, 'finish');
  assert.equal(f.sessions[0].breakpoint, null);
});

/* ===================== P1 · RQ-96 转化与耗时 ===================== */

test('P1 · RQ-96 转化率按 开始→首次决策 / 首次决策→完成 分别给出', () => {
  const f = summarizeFunnel([
    { sessionId: 1, decisions: 2, finishedAt: T0 },
    { sessionId: 2, decisions: 1 },
    { sessionId: 3, decisions: 0 },
    { sessionId: 4, decisions: 0 },
  ]);
  assert.equal(f.conversion.total, 4);
  assert.equal(f.conversion.startToFirstDecision, 50, '2/4 走到首次决策');
  assert.equal(f.conversion.firstToFinish, 50, '走到首次决策的 2 次里 1 次完成');
  assert.equal(f.conversion.startToFinish, 25);
});

test('P1 · RQ-96 开始→首次决策的中位耗时可算出，并对照 60 秒预算', () => {
  const f = summarizeFunnel([
    { sessionId: 1, startedAt: T0, firstDecisionAt: '2026-10-20T02:00:30.000Z', decisions: 1 },
    { sessionId: 2, startedAt: T0, firstDecisionAt: '2026-10-20T02:01:10.000Z', decisions: 1 },
    { sessionId: 3, startedAt: T0, firstDecisionAt: '2026-10-20T02:00:50.000Z', decisions: 1 },
  ]);
  assert.equal(f.timing.medianSecToFirstDecision, 50);
  assert.equal(f.timing.budgetSec, FIRST_DECISION_BUDGET_SEC);
  assert.equal(f.timing.withinBudgetCount, 2, '30 秒与 50 秒在预算内，70 秒超预算');
});

/* ===================== P3 · RQ-96 边界与异常 ===================== */

test('P3 · RQ-96 空数据与脏入参不抛错，计数为 0', () => {
  for (const bad of [null, undefined, [], 'x']) {
    const f = summarizeFunnel(bad);
    assert.equal(f.conversion.total, 0);
    assert.equal(f.steps[0].count, 0);
    assert.equal(f.conversion.startToFirstDecision, null, '无数据时转化率应为 null 而不是 NaN');
  }
  const text = JSON.stringify(summarizeFunnel([]));
  assert.ok(!text.includes('NaN'));
  assert.ok(!text.includes('Infinity'));
});

test('P3 · RQ-96 决策数为脏值（负数 / 字符串 / null）按 0 处理', () => {
  const f = summarizeFunnel([
    { sessionId: 1, decisions: -3 },
    { sessionId: 2, decisions: 'abc' },
    { sessionId: 3, decisions: null },
  ]);
  assert.equal(f.steps[0].count, 3);
  assert.equal(f.steps[1].count, 0, '脏决策数不得被当作「已决策」');
});

test('P3 · RQ-96 未完成的会话耗时为 null，不产生负数', () => {
  const f = summarizeFunnel([{ sessionId: 1, startedAt: T0, decisions: 1 }]);
  assert.equal(f.sessions[0].secTotal, null);
  assert.equal(f.sessions[0].secToFirstDecision, null);
});

/* ===================== P4 · RQ-96 性能 ===================== */

test('P4 · RQ-96 5000 个会话的漏斗聚合在预算内完成', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({
    sessionId: i + 1,
    startedAt: T0,
    firstDecisionAt: i % 3 === 0 ? '2026-10-20T02:00:20.000Z' : null,
    finishedAt: i % 5 === 0 ? '2026-10-20T02:03:00.000Z' : null,
    decisions: i % 7,
  }));
  const t0 = Date.now();
  const f = summarizeFunnel(rows);
  const ms = Date.now() - t0;
  assert.equal(f.conversion.total, 5000);
  assert.ok(ms < 1000, `5000 会话耗时 ${ms}ms，超过 1s 预算`);
});

/* ===================== P5 · RQ-96 兼容性与回归 ===================== */

test('P5 · RQ-96 步骤 key 与事件名保持稳定（看板与前端依赖）', () => {
  const byKey = Object.fromEntries(FUNNEL_STEPS.map((s) => [s.key, s.event]));
  assert.equal(byKey.start, 'blind_start');
  assert.equal(byKey.first_decision, 'blind_decision');
  assert.equal(byKey.finish, 'blind_finish');
  for (const s of FUNNEL_STEPS) assert.ok(s.label, `${s.key} 缺中文标签`);
});
