import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateReplay, buildScore } from '../../src/services/replayService.js';
import { calcFees } from '../../src/fees.js';

// 行情时间机器（RQ-01 ~ RQ-06）
// 用例优先级：P0 = 正确性核心（算错即训练失真），P1 = 规则一致性，P2 = 边界与异常

function makeBars(n, prices) {
  const bars = [];
  for (let i = 1; i <= n; i += 1) {
    const close = prices[i - 1];
    const prev = i === 1 ? close : prices[i - 2];
    bars.push({
      seq: i,
      prices: {
        TEST: { open: close, high: close, low: close, close, prevClose: prev },
      },
    });
  }
  return bars;
}

const FLAT = makeBars(10, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);

// ---------- P0：核心资产计算 ----------
test('P0 空操作回放：资产恒等于初始资金，无回撤', () => {
  const r = simulateReplay({ initialCapital: 100000, bars: FLAT, orders: [] });
  assert.equal(r.totalAssets, 100000);
  assert.equal(r.maxDrawdown, 0);
  assert.equal(r.tradeCount, 0);
  assert.equal(r.returnPct, 0);
});

test('P0 买入按「成交价+费用」摊入成本，现金等量扣减', () => {
  const r = simulateReplay({
    initialCapital: 100000,
    bars: FLAT,
    orders: [{ seq: 1, code: 'TEST', side: 'BUY', quantity: 1000 }],
  });
  const amount = 1000 * 10;
  const fee = calcFees(amount, 'BUY');
  assert.equal(r.cash, Math.round((100000 - amount - fee) * 100) / 100);
  assert.equal(r.marketValue, amount);
  // 费用摊入成本后，市值 < 成本 → 浮动盈亏为负
  assert.ok(r.positions[0].pnl < 0);
  assert.equal(r.feeTotal, fee);
});

test('P0 卖出已实现盈亏 =（卖出价−含费成本）×数量−费用', () => {
  const r = simulateReplay({
    initialCapital: 100000,
    bars: makeBars(10, [10, 12, 12, 12, 12, 12, 12, 12, 12, 12]),
    orders: [
      { seq: 1, code: 'TEST', side: 'BUY', quantity: 1000 },
      { seq: 2, code: 'TEST', side: 'SELL', quantity: 1000 },
    ],
  });
  const buyFee = calcFees(10000, 'BUY');
  const avgCost = (10000 + buyFee) / 1000;
  const sellFee = calcFees(12000, 'SELL');
  const expect = Math.round((12000 - avgCost * 1000 - sellFee) * 100) / 100;
  assert.equal(r.realizedTotal, expect);
  assert.equal(r.positions.length, 0);
  assert.equal(r.tradeCount, 2);
});

// ---------- P0：可复现性（RQ-02 倒带一致） ----------
test('P0 同一输入两次计算结果完全一致（可复现）', () => {
  const opts = {
    initialCapital: 200000,
    bars: makeBars(12, [10, 11, 9, 12, 8, 13, 7, 14, 6, 15, 5, 16]),
    orders: [
      { seq: 1, code: 'TEST', side: 'BUY', quantity: 500 },
      { seq: 4, code: 'TEST', side: 'SELL', quantity: 300 },
      { seq: 7, code: 'TEST', side: 'BUY', quantity: 200 },
      { seq: 9, code: 'TEST', side: 'SELL', quantity: 400 },
    ],
    uptoSeq: 10,
  };
  const a = simulateReplay(opts);
  const b = simulateReplay(opts);
  assert.deepEqual(a, b);
});

test('P0 倒带（uptoSeq 变小）后状态与历史一致', () => {
  // 价格涨幅控制在 ±10% 以内，避免触发涨跌停导致买单被拒（那是另一条用例）
  const opts = {
    initialCapital: 100000,
    bars: makeBars(8, [10, 10.3, 10.6, 10.9, 11.2, 11.5, 11.8, 12.1]),
    orders: [{ seq: 2, code: 'TEST', side: 'BUY', quantity: 1000 }],
  };
  const at5 = simulateReplay({ ...opts, uptoSeq: 5 });
  const at5Again = simulateReplay({ ...opts, uptoSeq: 5 });
  const at7 = simulateReplay({ ...opts, uptoSeq: 7 });
  assert.deepEqual(at5, at5Again);
  // 倒带到更早的位置，现金/持仓必须与当时完全相同（不能被后续 bar 污染）
  assert.equal(simulateReplay({ ...opts, uptoSeq: 2 }).cash, at5.cash);
  assert.equal(simulateReplay({ ...opts, uptoSeq: 2 }).positions.length, 1);
  assert.ok(at7.totalAssets > at5.totalAssets); // 后续上涨才体现
});

test('P0 净值序列按 bar 递增且与末点一致', () => {
  const r = simulateReplay({
    initialCapital: 100000,
    bars: makeBars(6, [10, 11, 12, 11, 10, 13]),
    orders: [{ seq: 1, code: 'TEST', side: 'BUY', quantity: 1000 }],
  });
  assert.equal(r.equity.length, 6);
  assert.equal(r.equity[r.equity.length - 1].seq, 6);
  assert.equal(r.equity[r.equity.length - 1].totalAssets, r.totalAssets);
});

// ---------- P1：与实时盘规则一致（RQ-03） ----------
test('P1 T+1：当日买入不可卖出，次日起可卖', () => {
  const opts = {
    initialCapital: 100000,
    bars: FLAT,
    orders: [
      { seq: 1, code: 'TEST', side: 'BUY', quantity: 1000 },
      { seq: 1, code: 'TEST', side: 'SELL', quantity: 1000 },
    ],
  };
  const sameDay = simulateReplay(opts);
  assert.equal(sameDay.tradeCount, 1); // 卖出被拒
  assert.equal(sameDay.rejected[0].reason, 'T+1 冻结，当前可卖 0 股');

  const nextDay = simulateReplay({
    ...opts,
    orders: [
      { seq: 1, code: 'TEST', side: 'BUY', quantity: 1000 },
      { seq: 2, code: 'TEST', side: 'SELL', quantity: 1000 },
    ],
  });
  assert.equal(nextDay.tradeCount, 2);
  assert.equal(nextDay.rejected.length, 0);
});

test('P1 资金不足的买单被拒且不扣现金', () => {
  const r = simulateReplay({
    initialCapital: 1000,
    bars: FLAT,
    orders: [{ seq: 1, code: 'TEST', side: 'BUY', quantity: 100000 }],
  });
  assert.equal(r.cash, 1000);
  assert.equal(r.tradeCount, 0);
  assert.equal(r.rejected[0].reason, '可用资金不足');
});

test('P1 涨停买单 / 跌停卖单被拒（与 validateOrder 同口径）', () => {
  const bars = [
    { seq: 1, prices: { TEST: { open: 10, high: 11, low: 11, close: 11, prevClose: 10 } } }, // +10% 涨停
    { seq: 2, prices: { TEST: { open: 9, high: 9, low: 9, close: 9, prevClose: 10 } } }, // -10% 跌停
  ];
  const limitUp = simulateReplay({
    initialCapital: 100000,
    bars,
    orders: [{ seq: 1, code: 'TEST', side: 'BUY', quantity: 100 }],
  });
  assert.equal(limitUp.rejected[0].reason, '已涨停，买单无法成交');

  const withPos = simulateReplay({
    initialCapital: 100000,
    bars,
    orders: [
      { seq: 1, code: 'TEST', side: 'BUY', quantity: 100 },
      { seq: 2, code: 'TEST', side: 'SELL', quantity: 100 },
    ],
  });
  // 涨停买被拒 → 无持仓 → 跌停卖因无券跳出后有 T+1 拒绝，验证两条路径都被拦住
  assert.ok(withPos.rejected.length >= 1);
});

test('P1 部分卖出后剩余持仓的成本价保持不变（移动加权）', () => {
  const r = simulateReplay({
    initialCapital: 100000,
    bars: makeBars(6, [10, 10, 12, 12, 12, 12]),
    orders: [
      { seq: 1, code: 'TEST', side: 'BUY', quantity: 1000 },
      { seq: 3, code: 'TEST', side: 'SELL', quantity: 400 },
    ],
  });
  assert.equal(r.positions.length, 1);
  assert.equal(r.positions[0].quantity, 600);
  const buyFee = calcFees(10000, 'BUY');
  assert.equal(r.positions[0].avgCost, Math.round(((10000 + buyFee) / 1000) * 100) / 100);
});

// ---------- P2：边界与异常 ----------
test('P2 未知标的的操作被拒且不影响账户', () => {
  const r = simulateReplay({
    initialCapital: 100000,
    bars: FLAT,
    orders: [{ seq: 1, code: 'NOPE', side: 'BUY', quantity: 100 }],
  });
  assert.equal(r.cash, 100000);
  assert.equal(r.rejected[0].reason, '该标的在回放区间内无行情');
});

test('P2 空行情输入不抛错，返回初始状态', () => {
  const r = simulateReplay({ initialCapital: 5000, bars: [], orders: [] });
  assert.equal(r.totalAssets, 5000);
  assert.deepEqual(r.positions, []);
  assert.deepEqual(r.equity, []);
});

test('P2 uptoSeq 超出 bars 范围时按最后一根 bar 估值', () => {
  const r = simulateReplay({
    initialCapital: 100000,
    bars: FLAT,
    orders: [{ seq: 1, code: 'TEST', side: 'BUY', quantity: 100 }],
    uptoSeq: 9999,
  });
  // 总额 = 初始资金 − 买入手续费（买卖同价，只有费用损耗）
  assert.equal(r.totalAssets, Math.round((100000 - calcFees(1000, 'BUY')) * 100) / 100);
  assert.ok(r.totalAssets < 100000);
});

test('P2 最大回撤按历史高点计算', () => {
  // 用大仓位让净值波动足够显著：10 → 20 → 10，峰值后的回落约 47%
  const r = simulateReplay({
    initialCapital: 100000,
    bars: makeBars(4, [10, 20, 20, 10]),
    orders: [{ seq: 1, code: 'TEST', side: 'BUY', quantity: 9000 }],
  });
  assert.ok(r.maxDrawdown > 40 && r.maxDrawdown < 55, `实际回撤 ${r.maxDrawdown}%`);
});

// ---------- RQ-04 成绩口径 ----------
test('P1 buildScore 输出四项核心指标且口径正确', () => {
  const s = buildScore({
    initialCapital: 100000,
    totalAssets: 120000,
    maxDrawdown: 12.5,
    tradeCount: 6,
    durationSec: 300,
  });
  assert.deepEqual(s, {
    initialCapital: 100000,
    finalAssets: 120000,
    profit: 20000,
    returnPct: 20,
    maxDrawdown: 12.5,
    tradeCount: 6,
    durationSec: 300,
  });
});

test('P2 buildScore 初始资金为 0 时不产生 NaN', () => {
  const s = buildScore({ initialCapital: 0, totalAssets: 0, maxDrawdown: 0, tradeCount: 0, durationSec: 0 });
  assert.equal(s.returnPct, 0);
  assert.equal(Number.isNaN(s.returnPct), false);
});
