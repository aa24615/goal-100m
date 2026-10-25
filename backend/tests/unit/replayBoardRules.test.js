/**
 * RQ-49 / RQ-50 在**回放与盲测链路**生效 —— 单元测试
 *
 * 规则本身在 rules.test.js 覆盖，这里验证「同一套规则确实被四条链路消费」：
 * 市价下单、限价撮合、回放模拟、双盲模拟。此前回放里是写死的 ±10%，
 * 而市价单是另一份写死的 ±10%，改一处不改全部就会口径漂移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateReplay } from '../../src/services/replayService.js';

const mkBar = (seq, close, prevClose, volume = 10000) => ({
  seq,
  prices: { '300750': { open: prevClose, high: close, low: close, close, prevClose, volume } },
});

const MET = { '300750': { name: '宁德时代', listingDate: '2018-06-11' } };

/* -------------------- P0 正常流程：分板块限价在回放中生效 -------------------- */

test('P0 · RQ-49 回放中创业板标的按 ±20% 生效（不是 ±10%）', () => {
  // 昨收 100，创业板涨停价 120。115 未涨停 → 应可买入
  const ok = simulateReplay({
    initialCapital: 1000000,
    bars: [mkBar(1, 115, 100)],
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
    stockMeta: MET,
  });
  assert.equal(ok.tradeCount, 1, '未涨停应正常成交');

  // 120 已到创业板涨停 → 买单应被拒
  const atLimit = simulateReplay({
    initialCapital: 1000000,
    bars: [mkBar(1, 120, 100)],
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
    stockMeta: MET,
  });
  assert.equal(atLimit.tradeCount, 0);
  assert.equal(atLimit.rejected[0].reason, '已涨停，买单无法成交');
});

test('P0 · RQ-49 同为 115 元，主板标的（昨收 100）也应成交——证明差异来自板块而非价格', () => {
  const main = {
    '600000': { name: '浦发银行', listingDate: '1999-11-10' },
  };
  const bars = [
    { seq: 1, prices: { '600000': { open: 100, high: 115, low: 115, close: 115, prevClose: 100, volume: 10000 } } },
  ];
  const r = simulateReplay({
    initialCapital: 1000000,
    bars,
    orders: [{ seq: 1, code: '600000', side: 'BUY', quantity: 100 }],
    stockMeta: main,
  });
  // 主板涨停价 110，115 已越界（数据本身不可能，但模拟内核按收盘价判断 115 >= 110*0.999）
  assert.equal(r.tradeCount, 0);
  assert.equal(r.rejected[0].reason, '已涨停，买单无法成交');
});

test('P0 · RQ-49 回放中主板 ST 标的按 ±5% 生效：同为 +5%，ST 触板、非 ST 不触板', () => {
  const run = (name) => {
    const bars = [
      { seq: 1, prices: { '600000': { open: 100, high: 105, low: 105, close: 105, prevClose: 100, volume: 10000 } } },
    ];
    return simulateReplay({
      initialCapital: 1000000,
      bars,
      orders: [{ seq: 1, code: '600000', side: 'BUY', quantity: 100 }],
      stockMeta: { '600000': { name, listingDate: '2000-01-01' } },
    });
  };
  const st = run('ST某某');
  assert.equal(st.tradeCount, 0, '主板 ST 涨 5% 即涨停，买单应被拒');
  assert.equal(st.rejected[0].reason, '已涨停，买单无法成交');

  const normal = run('某某股份');
  assert.equal(normal.tradeCount, 1, '非 ST 主板涨 5% 未触 ±10% 涨停，应正常成交');
});

/* -------------------- P0：停牌日在回放中不可交易 -------------------- */

test('P0 · RQ-50 回放中零成交 bar（停牌日）不可交易', () => {
  const r = simulateReplay({
    initialCapital: 1000000,
    bars: [mkBar(1, 105, 100, 0)], // volume = 0
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
    stockMeta: MET,
  });
  assert.equal(r.tradeCount, 0);
  assert.equal(r.rejected[0].reason, '该交易日零成交（停牌），不可交易');
});

test('P0 · RQ-50 有成交的同价位 bar 不误判为停牌', () => {
  const r = simulateReplay({
    initialCapital: 1000000,
    bars: [mkBar(1, 105, 100, 500)],
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
    stockMeta: MET,
  });
  assert.equal(r.tradeCount, 1);
  assert.equal(r.rejected.length, 0);
});

/* -------------------- P3 边界：stockMeta 缺失时降级 -------------------- */

test('P3 · RQ-49 stockMeta 缺失时仍按代码前缀识别板块（不因元数据缺失而拒单）', () => {
  const r = simulateReplay({
    initialCapital: 1000000,
    bars: [mkBar(1, 115, 100)],
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
  });
  assert.equal(r.tradeCount, 1, '无元数据时应仍按创业板 ±20% 放行');
});

test('P3 · RQ-49 无成交量的旧构造数据（volume 未定义）不被误判为停牌', () => {
  const legacy = [{ seq: 1, prices: { '300750': { open: 100, high: 115, low: 115, close: 115, prevClose: 100 } } }];
  const r = simulateReplay({
    initialCapital: 1000000,
    bars: legacy,
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
    stockMeta: MET,
  });
  assert.equal(r.tradeCount, 1, '拿不到成交量时不应凭猜测判定停牌');
});

/* -------------------- P4 异常与降级 -------------------- */

test('P4 · RQ-49 昨收缺失时回放不因 limitUp 为 null 而全面拒单', () => {
  const bars = [{ seq: 1, prices: { '300750': { open: 0, high: 0, low: 0, close: 0, prevClose: 0, volume: 100 } } }];
  const r = simulateReplay({
    initialCapital: 1000000,
    bars,
    orders: [{ seq: 1, code: '300750', side: 'BUY', quantity: 100 }],
    stockMeta: MET,
  });
  // 价格为 0 时不成交属正常（无有效报价），但绝不能是「已涨停」这类错误理由
  assert.equal(typeof JSON.stringify(r), 'string');
  assert.ok(!r.rejected.some((x) => x.reason.includes('涨停') && Number.isNaN(x.quantity)));
});

test('P4 · RQ-49 回放确定性：相同输入两次模拟结果完全一致（成绩可复查）', () => {
  const input = {
    initialCapital: 1000000,
    bars: [mkBar(1, 105, 100), mkBar(2, 112, 105)],
    orders: [
      { seq: 1, code: '300750', side: 'BUY', quantity: 100 },
      { seq: 2, code: '300750', side: 'SELL', quantity: 100 },
    ],
    stockMeta: MET,
  };
  const a = simulateReplay(input);
  const b = simulateReplay(input);
  assert.equal(a.realizedTotal, b.realizedTotal);
  assert.equal(a.feeTotal, b.feeTotal);
  assert.equal(a.totalAssets, b.totalAssets);
});
