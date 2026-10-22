import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairTrades,
  buildScorecard,
  maxDrawdownOf,
  composeReport,
  complianceCheck,
  resolvePeriod,
  DISCLAIMER,
} from '../../src/services/reviewService.js';

// 复盘与战绩中心（RQ-07 ~ RQ-11）
// P0：配对盈亏必须与账户已实现盈亏严格一致（验收硬指标 ≤0.01 元）

const T = (o) => ({
  id: o.id,
  stockCode: '600001',
  stockName: '启明智能',
  type: o.type,
  quantity: o.quantity,
  price: o.price,
  amount: o.quantity * o.price,
  fee: o.fee ?? 5,
  realizedPnl: o.realizedPnl ?? null,
  createdAt: o.at,
});

test('P0 一笔完整买卖被配对成一回合，含持有天数与收益率', () => {
  const txs = [
    T({ id: 1, type: 'BUY', quantity: 1000, price: 10, at: '2026-10-01T10:00:00Z' }),
    T({ id: 2, type: 'SELL', quantity: 1000, price: 12, at: '2026-10-05T10:00:00Z' }),
  ];
  const { rounds } = pairTrades(txs);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].status, 'closed');
  assert.equal(rounds[0].holdDays, 4);
  assert.equal(rounds[0].quantity, 1000);
  assert.ok(rounds[0].returnPct > 0);
  assert.equal(rounds[0].legs[0].buyId, 1); // 可追溯到配对买入
});

test('P0 配对盈亏合计与账户已实现盈亏一致（误差 ≤0.01）', () => {
  // 期望值在测试内独立推导（移动加权成本口径），不复用被测代码
  const avgAfter2 = (1000 * 10 + 5.1 + 1000 * 12 + 5.6) / 2000; // 11.00535
  const sell1Fee = 5 + 800 * 13 * 0.0005 + 800 * 13 * 0.00001; // 佣金取最低 5 元
  const sell2Fee = 5 + 1200 * 11 * 0.0005 + 1200 * 11 * 0.00001;
  const r1 = (13 - avgAfter2) * 800 - sell1Fee;
  const r2 = (11 - avgAfter2) * 1200 - sell2Fee;

  const txs = [
    T({ id: 1, type: 'BUY', quantity: 1000, price: 10, fee: 5.1, at: '2026-10-01T10:00:00Z' }),
    T({ id: 2, type: 'BUY', quantity: 1000, price: 12, fee: 5.6, at: '2026-10-02T10:00:00Z' }),
    T({ id: 3, type: 'SELL', quantity: 800, price: 13, fee: Math.round(sell1Fee * 100) / 100, realizedPnl: Math.round(r1 * 100) / 100, at: '2026-10-03T10:00:00Z' }),
    T({ id: 4, type: 'SELL', quantity: 1200, price: 11, fee: Math.round(sell2Fee * 100) / 100, realizedPnl: Math.round(r2 * 100) / 100, at: '2026-10-06T10:00:00Z' }),
  ];
  const { realizedSum } = pairTrades(txs);
  const dbSum = txs.reduce((s, t) => s + (t.type === 'SELL' ? t.realizedPnl : 0), 0);
  assert.ok(Math.abs(dbSum - realizedSum) <= 0.01, `差 ${Math.abs(dbSum - realizedSum)}`);
});

test('P0 配对算法与服务端口径同源：加仓后成本为移动加权平均', () => {
  const txs = [
    T({ id: 1, type: 'BUY', quantity: 1000, price: 10, fee: 5.1, at: '2026-10-01T10:00:00Z' }),
    T({ id: 2, type: 'BUY', quantity: 1000, price: 12, fee: 5.6, at: '2026-10-02T10:00:00Z' }),
    T({ id: 3, type: 'SELL', quantity: 2000, price: 11, fee: 16.6, at: '2026-10-06T10:00:00Z' }),
  ];
  const { rounds } = pairTrades(txs);
  // 加权成本 = (10000+5.1 + 12000+5.6) / 2000 = 11.00535
  const expectCost = (10000 + 5.1 + 12000 + 5.6) / 2000;
  assert.equal(rounds[0].avgCost, Math.round(expectCost * 100) / 100);
  // realized = 22000 - 22010.7 - 16.6 = -27.3
  assert.equal(rounds[0].realizedPnl, Math.round((22000 - expectCost * 2000 - 16.6) * 100) / 100);
});

test('P1 未平仓部分单独成笔，状态为 open 且带浮动盈亏', () => {
  const txs = [T({ id: 1, type: 'BUY', quantity: 500, price: 20, at: '2026-10-01T10:00:00Z' })];
  const { rounds } = pairTrades(txs, { '600001': 22 });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].status, 'open');
  assert.equal(rounds[0].realizedPnl, 0);
  // 成本含费：(10000 + 5) / 500 = 20.01 → 浮动 = (22 − 20.01) × 500 = 995
  assert.equal(rounds[0].unrealizedPnl, 995);
  assert.ok(rounds[0].returnPct > 0);
});

test('P2 边界：空流水返回空回合，不抛错', () => {
  const { rounds, realizedSum } = pairTrades([]);
  assert.deepEqual(rounds, []);
  assert.equal(realizedSum, 0);
});

test('P2 异常：无持仓却出现卖出记录时被跳过，不产生脏数据', () => {
  const txs = [T({ id: 1, type: 'SELL', quantity: 100, price: 10, at: '2026-10-01T10:00:00Z' })];
  const { rounds } = pairTrades(txs);
  assert.equal(rounds.length, 0);
});

test('P2 多标的分别配对，互不串账', () => {
  const txs = [
    T({ id: 1, type: 'BUY', quantity: 100, price: 10, at: '2026-10-01T10:00:00Z' }),
    { ...T({ id: 2, type: 'BUY', quantity: 100, price: 50, at: '2026-10-01T10:00:00Z' }), stockCode: '600519', stockName: '黔岭酒业' },
    T({ id: 3, type: 'SELL', quantity: 100, price: 11, at: '2026-10-02T10:00:00Z' }),
  ];
  const { rounds } = pairTrades(txs);
  assert.equal(rounds.length, 2);
  const closed = rounds.find((r) => r.status === 'closed');
  const open = rounds.find((r) => r.status === 'open');
  assert.equal(closed.code, '600001');
  assert.equal(open.code, '600519');
});

// ---------- RQ-08 战绩卡 ----------
test('P0 胜率按已平仓回合计算，未平仓不计入', () => {
  const rounds = [
    { status: 'closed', realizedPnl: 100, fee: 5, holdDays: 2 },
    { status: 'closed', realizedPnl: -50, fee: 5, holdDays: 1 },
    { status: 'open', realizedPnl: 0, fee: 0, holdDays: 9 },
  ];
  const c = buildScorecard({ rounds, initialCapital: 100000, equitySeries: [], activeDays: 0 });
  assert.equal(c.winRate, 50);
  assert.equal(c.roundCount, 2);
  assert.equal(c.openCount, 1);
  assert.equal(c.avgHoldDays, 1.5);
});

test('P1 盈亏比 = 总盈利 / 总亏损，无亏损时为 null 而非 Infinity', () => {
  const winOnly = buildScorecard({
    rounds: [{ status: 'closed', realizedPnl: 100, fee: 0, holdDays: 1 }],
    initialCapital: 100000,
  });
  assert.equal(winOnly.profitFactor, null);

  const both = buildScorecard({
    rounds: [
      { status: 'closed', realizedPnl: 300, fee: 0, holdDays: 1 },
      { status: 'closed', realizedPnl: -100, fee: 0, holdDays: 1 },
    ],
    initialCapital: 100000,
  });
  assert.equal(both.profitFactor, 3);
});

test('P1 手续费占比 = 手续费 / 初始资金', () => {
  const c = buildScorecard({
    rounds: [{ status: 'closed', realizedPnl: 10, fee: 1000, holdDays: 1 }],
    initialCapital: 100000,
    activeDays: 5,
  });
  assert.equal(c.feeRatio, 1);
  assert.equal(c.tradeFrequency, 0.2);
});

test('P2 边界：无回合时各项指标为 0 而非 NaN', () => {
  const c = buildScorecard({ rounds: [], initialCapital: 100000, equitySeries: [] });
  assert.equal(c.winRate, 0);
  assert.equal(c.profitFactor, 0);
  assert.equal(Number.isNaN(c.maxDrawdown), false);
});

test('P1 最大回撤按历史高点计算', () => {
  assert.equal(maxDrawdownOf([100, 120, 90, 130]), 25);
});

test('P2 最大回撤对空序列与非法值返回 0', () => {
  assert.equal(maxDrawdownOf([]), 0);
  assert.equal(maxDrawdownOf([null, NaN, undefined]), 0);
});

// ---------- RQ-10 AI 复盘报告 ----------
const reportCtx = (over = {}) => ({
  rounds: [
    { status: 'closed', realizedPnl: 200, fee: 300, holdDays: 0, seq: 1 },
    { status: 'closed', realizedPnl: -600, fee: 300, holdDays: 6, seq: 2 },
  ],
  scorecard: { maxDrawdown: 15, feeRatio: 0.6, profitFactor: 0.4, winRate: 50, totalFee: 600 },
  initialCapital: 100000,
  currentAssets: 101000,
  returnPct: 1,
  benchmarkPct: 2,
  ...over,
});

test('P0 各回合费用之和等于全部手续费（买入费用不得漏记）', () => {
  const txs = [
    T({ id: 1, type: 'BUY', quantity: 1000, price: 10, fee: 5.1, at: '2026-10-01T10:00:00Z' }),
    T({ id: 2, type: 'SELL', quantity: 400, price: 11, fee: 8.6, at: '2026-10-03T10:00:00Z' }),
  ];
  const { rounds, feeSum } = pairTrades(txs);
  // 金额一律按「分」比较：各回合费用已分别四舍五入到分位，
  // 直接对浮点求和会得到 10.64 + 3.06 = 13.700000000000001 这类噪声。
  const roundFees = Math.round(rounds.reduce((s, r) => s + r.fee, 0) * 100) / 100;
  assert.equal(roundFees, feeSum);
  // 卖出 400/1000 → 部分止盈，该回合状态为 partial，费用 = 卖出费 8.6 + 归属买入费 2.04
  assert.equal(rounds.find((r) => r.status === 'partial').fee, 10.64);
  // 剩余 600 股仍承担 3.06 元买入费
  assert.equal(rounds.find((r) => r.status === 'open').fee, 3.06);
});

test('P0 报告必须携带免责声明（合规硬约束）', () => {
  const r = composeReport(reportCtx());
  assert.equal(r.disclaimer, DISCLAIMER);
  assert.match(r.disclaimer, /不构成投资建议/);
});

test('P0 建议数量限定在 1~3 条', () => {
  const r = composeReport(reportCtx());
  assert.ok(r.suggestions.length >= 1 && r.suggestions.length <= 3, `实际 ${r.suggestions.length} 条`);
});

test('P0 报告不含标的推荐与收益承诺（合规闸门）', () => {
  const r = composeReport(reportCtx());
  const text = JSON.stringify(r);
  assert.ok(!/必涨|稳赚|保证收益|翻倍|无风险/.test(text));
  // 含具体标的的代码一律视为推荐，无论上下文
  assert.equal(complianceCheck('明天 600001 会涨，赶紧买入').ok, false);
  assert.equal(complianceCheck('推荐关注 300059').ok, false);
  assert.equal(complianceCheck('这只稳赚，保证收益').ok, false);
  assert.equal(complianceCheck('建议把止损位固定下来，控制回撤').ok, true);
});

test('P1 合规闸门只拦截自然语言，不误伤金额数字', () => {
  // 手续费 ¥123456.00 含连续六位数字，但出现在浮点字段里不应触发拦截
  const r = composeReport({ ...reportCtx(), scorecard: { maxDrawdown: 15, feeRatio: 0.6, profitFactor: 0.4, winRate: 50, totalFee: 123456 } });
  assert.equal(r.compliance, 'passed');
  assert.ok(r.suggestions.length >= 1);
});

test('P1 样本不足时给出引导性建议而非空报告', () => {
  const r = composeReport({ rounds: [], scorecard: { feeRatio: 0, maxDrawdown: 0 } });
  assert.ok(r.suggestions.length >= 1);
  assert.equal(r.sampleSize, 0);
});

test('P1 超额收益与跑赢/跑输判定正确', () => {
  const win = composeReport(reportCtx({ returnPct: 5, benchmarkPct: 2 }));
  assert.equal(win.headline.excessPct, 3);
  assert.equal(win.headline.outcome, '跑赢同期大盘');

  const lose = composeReport(reportCtx({ returnPct: 1, benchmarkPct: 4 }));
  assert.equal(lose.headline.outcome, '跑输同期大盘');

  const flat = composeReport(reportCtx({ returnPct: 2, benchmarkPct: 2 }));
  assert.equal(flat.headline.outcome, '与同期大盘持平');
});

// ---------- 边界：周期解析 ----------
test('P2 非法周期回退为 30d', () => {
  assert.equal(resolvePeriod('7d'), '7d');
  assert.equal(resolvePeriod('nonsense'), '30d');
  assert.equal(resolvePeriod(undefined), '30d');
});
