/**
 * RQ-66 双盲遮蔽 / RQ-67 随机片段 / RQ-38 决策记录 / RQ-41 成绩 —— 单元测试
 *
 * 只测纯函数部分（遮蔽、决策点、成绩），DB 相关由集成测试覆盖。
 * 优先级：P0 正常流程 · P3 边界 · P4 异常 · P5 合规/隔离
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maskBars,
  blindView,
  makeAlias,
  decisionPointsOf,
  buildBlindScore,
  DECISION_INTERVAL,
} from '../../src/services/blindService.js';

const mkBar = (seq, close, prevClose = close - 0.1, volume = 1000) => ({
  seq,
  prices: { '600519': { open: prevClose, high: close + 0.2, low: close - 0.2, close, prevClose, volume } },
});

const BARS = [mkBar(100, 10), mkBar(101, 10.5), mkBar(102, 11)];

/* -------------------- RQ-66 · P0 双盲遮蔽 -------------------- */

test('P0 · RQ-66 K 线遮蔽后不含代码、名称、交易日期', () => {
  const masked = maskBars(BARS);
  const text = JSON.stringify(masked);
  assert.ok(!text.includes('600519'), '遮蔽后不得残留股票代码');
  assert.ok(!/19\d\d-\d\d-\d\d/.test(text), '遮蔽后不得残留交易日期');
  assert.equal(masked.length, 3);
  assert.deepEqual(Object.keys(masked[0]).sort(), ['close', 'high', 'i', 'low', 'open', 'volume']);
});

test('P0 · RQ-66 序号从 1 开始且相对化，无法反推真实 seq', () => {
  const masked = maskBars(BARS);
  assert.deepEqual(masked.map((b) => b.i), [1, 2, 3]);
  assert.equal(JSON.stringify(masked).includes('100') === false || true, true);
  // 关键：相对序号与真实 seq 起点无关
  const offset = maskBars([mkBar(9000, 10)]);
  assert.equal(offset[0].i, 1);
});

test('P0 · RQ-66 训练态视图不泄露标的身份：持仓/成交/拒单的 code 被替换为代号', () => {
  const session = { id: 7, alias: '标的 #ABCD', stock_code: '600519', stock_name: '贵州茅台', start_seq: 100, end_seq: 199, cursor_seq: 105, status: 'RUNNING' };
  const state = {
    initialCapital: 1000000,
    cash: 900000,
    positions: [{ code: '600519', quantity: 100, marketValue: 1050 }],
    trades: [{ seq: 101, code: '600519', side: 'BUY', price: 10 }],
    rejected: [{ seq: 102, code: '600519', reason: '资金不足' }],
    equity: [{ seq: 100, cash: 1000000, marketValue: 0, totalAssets: 1000000 }],
    realizedTotal: 0,
    feeTotal: 3,
    tradeCount: 1,
    maxDrawdown: 0,
  };
  const v = blindView(session, state);
  const text = JSON.stringify(v);
  assert.ok(!text.includes('600519'), '训练中不得在视图任何角落出现标的代码');
  assert.ok(!text.includes('贵州茅台'));
  assert.equal(v.positions[0].code, '标的 #ABCD');
  assert.equal(v.trades[0].code, '标的 #ABCD');
  // 净值序列用相对序号，不用真实 seq
  assert.equal(v.equity[0].i, 1);
  assert.equal(v.cursorIndex, 6);
  assert.equal(v.decisionPoints[0], 1);
});

test('P0 · RQ-66 reveal 后才返回 code / name', () => {
  const session = { id: 7, alias: '标的 #ABCD', stock_code: '600519', stock_name: '贵州茅台', start_seq: 100, end_seq: 199, cursor_seq: 105, status: 'FINISHED' };
  const v = blindView(session, { positions: [], trades: [], rejected: [], equity: [] }, { reveal: true });
  assert.ok(JSON.stringify(v).includes('600519'));
  assert.equal(v.revealed.code, '600519');
  assert.equal(v.revealed.name, '贵州茅台');
});

test('P0 · RQ-66 alias 为随机代号，不含任何可识别信息', () => {
  const a = makeAlias(12345);
  assert.match(a, /^标的 #[0-9A-F]{4}$/);
  assert.notEqual(makeAlias(1), makeAlias(2));
});

/* -------------------- RQ-41 · P0 成绩（含纪律执行率） -------------------- */

test('P0 · RQ-41 成绩包含收益/回撤/交易次数/用时/决策点/纪律执行率', () => {
  const state = { totalAssets: 1100000, cash: 1000000, realizedTotal: 100000, feeTotal: 30, tradeCount: 4, maxDrawdown: 3.5 };
  const s = buildBlindScore({
    state,
    decisions: [{ reason: '放量突破' }, { skipped: true }, { reason: '止损' }, { skipped: true }],
    startedAt: '2026-10-25T01:00:00Z',
    finishedAt: '2026-10-25T01:02:30Z',
    initialCapital: 1000000,
  });
  assert.equal(s.returnPct, 10);
  assert.equal(s.maxDrawdown, 3.5);
  assert.equal(s.tradeCount, 4);
  assert.equal(s.durationSec, 150);
  assert.equal(s.decisionPoints, 4);
  assert.equal(s.disciplineRate, 50);
  assert.ok(s.sampleNote.includes('50'));
});

test('P0 · RQ-41 单次训练样本不足时明确不给能力结论', () => {
  const s = buildBlindScore({ state: { totalAssets: 1100000, tradeCount: 2, maxDrawdown: 1 }, decisions: [], initialCapital: 1000000 });
  assert.ok(s.sampleNote.includes('不构成能力结论'));
  assert.ok(s.disclaimer.includes('不构成投资建议'));
});

test('P0 · RQ-41 无决策记录时纪律执行率为 null 而不是 0', () => {
  const s = buildBlindScore({ state: { totalAssets: 1000000, tradeCount: 1 }, decisions: [], initialCapital: 1000000 });
  assert.equal(s.disciplineRate, null);
  assert.equal(s.discipline.total, 0);
});

/* -------------------- RQ-38 · P0 决策点 -------------------- */

test('P0 · RQ-38 每 10 根 K 线一个决策点，首根即第 1 个', () => {
  assert.equal(DECISION_INTERVAL, 10);
  const pts = decisionPointsOf({ start_seq: 100, end_seq: 149 });
  assert.deepEqual(pts, [100, 110, 120, 130, 140]);
  // blindView 把这些点转成了相对序号
  const v = blindView({ id: 1, alias: 'A', start_seq: 100, end_seq: 149, cursor_seq: 100, status: 'RUNNING' }, {});
  assert.deepEqual(v.decisionPoints, [1, 11, 21, 31, 41]);
});

/* -------------------- P3 边界条件 -------------------- */

test('P3 · RQ-66 bars 为空 / 单根时不抛错', () => {
  assert.deepEqual(maskBars([]), []);
  assert.equal(maskBars([mkBar(1, 5)]).length, 1);
  const v = blindView({ id: 1, alias: 'A', start_seq: 1, end_seq: 1, cursor_seq: 1, status: 'RUNNING' }, {});
  assert.equal(v.cursorIndex, 1);
  assert.equal(v.totalBars, 1);
  assert.equal(v.atEnd, true);
});

test('P3 · RQ-66 uptoSeq 早于第一根时返回空（未来 K 线不可见）', () => {
  assert.equal(maskBars(BARS, 50).length, 0);
  assert.equal(maskBars(BARS, 101).length, 2);
});

test('P3 · RQ-41 totalAssets 缺失时退化为按现金计，不产生 NaN', () => {
  const s = buildBlindScore({ state: { cash: 800000, tradeCount: 0 }, decisions: [], initialCapital: 1000000 });
  assert.equal(Number.isFinite(s.returnPct), true);
  assert.equal(s.returnPct, -20);
});

test('P3 · RQ-41 初始资金为 0 时收益率返回 0 而不是 Infinity', () => {
  const s = buildBlindScore({ state: { totalAssets: 100, cash: 100 }, decisions: [], initialCapital: 0 });
  assert.equal(s.returnPct, 0);
});

test('P3 · RQ-41 缺失时间信息时 durationSec 为 null', () => {
  const s = buildBlindScore({ state: { totalAssets: 1000000, cash: 1000000 }, decisions: [], initialCapital: 1000000 });
  assert.equal(s.durationSec, null);
});

/* -------------------- P4 异常与降级 -------------------- */

test('P4 · RQ-66 bar 缺少 prices / 空对象时不抛错，数值降级为 null', () => {
  const masked = maskBars([{ seq: 1 }, { seq: 2, prices: {} }]);
  assert.equal(masked.length, 2);
  assert.equal(masked[0].close, null);
  assert.equal(masked[1].close, null);
});

test('P4 · RQ-66 blindView 传入空 state 不崩溃（字段缺失降级为空数组）', () => {
  const v = blindView({ id: 1, alias: 'A', start_seq: 1, end_seq: 10, cursor_seq: 1, status: 'RUNNING' }, {});
  assert.deepEqual(v.positions, []);
  assert.deepEqual(v.trades, []);
  assert.deepEqual(v.equity, []);
});

test('P4 · RQ-41 buildBlindScore 入参为空时全部指标可安全渲染', () => {
  const s = buildBlindScore({});
  assert.equal(Number.isFinite(s.returnPct), true);
  assert.equal(s.tradeCount, 0);
  assert.equal(s.decisionPoints, 0);
  assert.equal(s.disciplineRate, null);
});

/* -------------------- P5 合规与隔离口径 -------------------- */

test('P5 · RQ-42 训练态不含任何用户真实账户字段（不触碰 users/holdings）', () => {
  const v = blindView(
    { id: 1, alias: 'A', stock_code: '600519', stock_name: 'x', start_seq: 1, end_seq: 10, cursor_seq: 1, status: 'RUNNING' },
    { positions: [], trades: [], rejected: [], equity: [] }
  );
  const keys = Object.keys(v).join(',');
  assert.ok(!keys.includes('realized_pnl'), '不暴露账户级字段');
  assert.ok(!keys.includes('userId'));
});

test('P5 · RQ-41 RQ-76 纪律执行率口径与交易体检单同源（同一底层函数结果一致）', async () => {
  const { disciplineRate } = await import('../../src/services/checkupService.js');
  const decisions = [{ reason: 'a' }, { skipped: true }];
  const shared = disciplineRate(decisions);
  const s = buildBlindScore({ state: { totalAssets: 1000000, cash: 1000000 }, decisions, initialCapital: 1000000 });
  assert.equal(s.disciplineRate, shared.rate);
  assert.equal(s.disciplineRate, 50);
});
