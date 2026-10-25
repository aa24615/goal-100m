/**
 * RQ-49 分板块涨跌幅 / RQ-50 停牌不可交易 —— 单元测试
 *
 * 优先级标签：
 *   P0 = 需求 P0 的正常流程；P3 = 边界条件；P4 = 异常与降级；P5 = 合规/口径一致性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBoard,
  priceLimitOf,
  haltReason,
  guardTrade,
  boardRuleTable,
  ST_LIMIT,
} from '../../src/rules.js';

/* ------------------------- RQ-49 · P0 正常流程 ------------------------- */

test('P0 · RQ-49 主板 60/00 开头识别为主板 ±10%', () => {
  const a = classifyBoard('600519', '贵州茅台');
  assert.equal(a.board, 'MAIN');
  assert.equal(a.riskWarning, false);
  const l = priceLimitOf('600519', '贵州茅台', 100);
  assert.equal(l.limit, 0.1);
  assert.equal(l.limitUp, 110);
  assert.equal(l.limitDown, 90);
});

test('P0 · RQ-49 创业板 300/301 识别为 ±20%', () => {
  for (const code of ['300750', '301269']) {
    const l = priceLimitOf(code, '某某股份', 50);
    assert.equal(l.board, 'GEM');
    assert.equal(l.limit, 0.2);
    assert.equal(l.limitUp, 60);
    assert.equal(l.limitDown, 40);
  }
});

test('P0 · RQ-49 科创板 688/689 识别为 ±20%', () => {
  const l = priceLimitOf('688981', '中芯国际', 80);
  assert.equal(l.board, 'STAR');
  assert.equal(l.limit, 0.2);
  assert.equal(l.limitUp, 96);
  assert.equal(l.limitDown, 64);
});

test('P0 · RQ-49 北交所（43/83/87/88/920）识别为 ±30%（RK-04 主要口径）', () => {
  for (const code of ['430047', '830799', '871981', '889999', '920002']) {
    const l = priceLimitOf(code, '某某北交所', 10);
    assert.equal(l.board, 'BSE', `${code} 应识别为北交所`);
    assert.equal(l.limit, 0.3);
    assert.equal(l.limitUp, 13);
    assert.equal(l.limitDown, 7);
  }
});

test('P0 · RQ-49 主板 ST 降为 ±5%，*ST 同样命中', () => {
  for (const name of ['ST某某', '*ST某某', 'st某某']) {
    const l = priceLimitOf('600000', name, 20);
    assert.equal(l.riskWarning, true, name);
    assert.equal(l.limit, ST_LIMIT);
    assert.equal(l.limitUp, 21);
    assert.equal(l.limitDown, 19);
  }
});

test('P0 · RQ-49 创业板 ST 不降幅（仍 ±20%）—— ST 只在主板收窄', () => {
  const l = priceLimitOf('300156', 'ST某某创', 10);
  assert.equal(l.board, 'GEM');
  assert.equal(l.riskWarning, true);
  assert.equal(l.limit, 0.2, '创业板 ST 不应被降为 5%');
});

/* ------------------------- RQ-49 · P3 边界条件 ------------------------- */

test('P3 · RQ-49 未识别前缀按主板兜底且不抛错（RK-04 兜底要求）', () => {
  const l = priceLimitOf('999999', '未知标的', 10);
  assert.equal(l.board, 'MAIN');
  assert.equal(l.fallback, true);
  assert.equal(l.limit, 0.1);
});

test('P3 · RQ-49 昨收为 0 / NaN 时不做除法，返回无涨跌停而非 Infinity', () => {
  for (const prev of [0, NaN, undefined, null]) {
    const l = priceLimitOf('600000', '测试', prev);
    assert.equal(l.limitUp, null, `prevClose=${prev} 应无涨停价`);
    assert.equal(l.limitDown, null);
    assert.ok(!Number.isNaN(l.limitDown));
  }
});

test('P3 · RQ-49 涨停/跌停边界：触及涨停拒买单，明显低于涨停放行', () => {
  const prev = 10;
  const l = priceLimitOf('600000', '测试', prev);
  // 触及涨停价（±0.1% 容差内）一律拒绝：真实市场这个价位买单排不上队
  const atUp = guardTrade({ code: '600000', name: '测试', type: 'BUY', price: l.limitUp, prevClose: prev, quantity: 100 });
  assert.equal(atUp.ok, false);
  assert.equal(atUp.code, 'LIMIT_UP');

  const mid = guardTrade({ code: '600000', name: '测试', type: 'BUY', price: 10.5, prevClose: prev, quantity: 100 });
  assert.equal(mid.ok, true);

  const downAtLimit = guardTrade({ code: '600000', name: '测试', type: 'SELL', price: l.limitDown, prevClose: prev, quantity: 100 });
  assert.equal(downAtLimit.ok, false);
  assert.equal(downAtLimit.code, 'LIMIT_DOWN');
});

test('P3 · RQ-49 数量非整手被拒；0 / 负数同样拒绝', () => {
  // 明确给成交量（非零）：保证先走到整手校验而不是被停牌判定短路
  const base = { code: '600000', name: '测试', price: 10, prevClose: 10, volume: 1000, type: 'BUY' };
  assert.equal(guardTrade({ ...base, quantity: 37 }).code, 'LOT_SIZE');
  assert.equal(guardTrade({ ...base, quantity: 0 }).code, 'LOT_SIZE');
  assert.equal(guardTrade({ ...base, quantity: -100 }).code, 'LOT_SIZE');
  assert.equal(guardTrade({ ...base, quantity: 100 }).ok, true);
});

test('P3 · RQ-49 新股上市前 5 日免涨跌幅，第 6 日起恢复 ±10%', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  const day0 = priceLimitOf('600000', '新股份', 10, '2026-10-20', now);
  assert.equal(day0.exempt, true);
  assert.equal(day0.limitUp, null);

  const day5 = priceLimitOf('600000', '新股份', 10, '2026-10-15', now);
  assert.equal(day5.exempt, false, '第 6 个交易日应恢复涨跌幅');
  assert.equal(day5.limit, 0.1);
});

test('P3 · RQ-49 免涨跌幅（limitUp 为 null）时买单不因 >= 0 被误拒', () => {
  // 回购 2026-10 的事故：lim.limitUp 为 null 时 `price >= null * 0.999` 恒真 → 全面拒单
  const now = new Date('2026-10-20T10:00:00Z');
  const g = guardTrade({
    code: '600000',
    name: '新股',
    type: 'BUY',
    price: 999,
    prevClose: 10,
    listingDate: '2026-10-20',
    now,
    quantity: 100,
  });
  assert.equal(g.ok, true, '免涨跌幅的标的不应被涨跌停逻辑拦截');
});

/* ------------------------- RQ-50 · P0 正常流程 ------------------------- */

test('P0 · RQ-50 trade_status=HALTED 拒绝并给出原因', () => {
  const r = haltReason({ code: '600000', price: 10, prevClose: 10, volume: 100, tradeStatus: 'HALTED' });
  assert.equal(r.code, 'HALTED');
  assert.ok(r.message.includes('停牌'));

  const g = guardTrade({ code: '600000', name: '停牌股', price: 10, prevClose: 10, tradeStatus: 'HALTED', quantity: 100 });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'HALTED');
  assert.equal(g.status, 400);
});

test('P0 · RQ-50 trade_status=DELISTED 拒绝并给出原因', () => {
  const r = haltReason({ code: '600000', price: 10, prevClose: 10, volume: 0, tradeStatus: 'DELISTED' });
  assert.equal(r.code, 'DELISTED');
  assert.ok(r.message.includes('退市'));
});

test('P0 · RQ-50 无有效报价（price<=0）判定不可交易', () => {
  assert.equal(haltReason({ price: 0, prevClose: 10, volume: 100 }).code, 'NO_QUOTE');
  assert.equal(haltReason({ price: NaN, prevClose: 10, volume: 100 }).code, 'NO_QUOTE');
  assert.equal(haltReason({}).code, 'NO_QUOTE');
});

test('P0 · RQ-50 零成交 + 价格未变动判定为停牌，并附行情滞后时间', () => {
  const r = haltReason({ price: 10, prevClose: 10, volume: 0, quoteAgeMs: 300000 });
  assert.equal(r.code, 'SUSPENDED');
  assert.ok(r.message.includes('300 秒'));
});

test('P0 · RQ-50 正常标的不误判为停牌', () => {
  assert.equal(haltReason({ price: 10.5, prevClose: 10, volume: 12345 }), null);
  // 价格未动但有成交：不是停牌（一字板的极端情形仍可交易）
  assert.equal(haltReason({ price: 10, prevClose: 10, volume: 500 }), null);
});

/* ------------------------- RQ-49/50 · P4 异常与降级 ------------------------- */

test('P4 · RQ-50 空对象 / 缺字段不抛异常，一律落到「无有效报价」', () => {
  for (const input of [undefined, null, {}, { prevClose: 0, volume: 0 }]) {
    const r = haltReason(input);
    assert.ok(r && typeof r.code === 'string');
  }
});

test('P4 · RQ-49 trade_status 大小写/脏值不影响判定', () => {
  assert.equal(haltReason({ tradeStatus: 'halted', price: 1, prevClose: 1, volume: 1 }).code, 'HALTED');
  assert.equal(haltReason({ tradeStatus: 'normal', price: 1, prevClose: 1, volume: 1 }), null);
});

test('P4 · RQ-49 guardTrade 缺 type 时不误判涨跌停', () => {
  const g = guardTrade({ code: '600000', name: '测试', price: 11, prevClose: 10, quantity: 100 });
  assert.equal(g.ok, true);
});

/* ------------------------- RQ-49 · P5 口径一致性 ------------------------- */

test('P5 · RQ-72 板块规则表对外暴露完整且与 commit 口径一致', () => {
  const t = boardRuleTable();
  assert.equal(t.boards.MAIN.limit, 0.1);
  assert.equal(t.boards.GEM.limit, 0.2);
  assert.equal(t.boards.STAR.limit, 0.2);
  assert.equal(t.boards.BSE.limit, 0.3);
  assert.equal(t.stLimit, 0.05);
  assert.equal(t.newListingExemptDays, 5);
});

test('P5 · RQ-49 全市场不再存在一刀切 ±10%：四类板块至少三类不是 10%', () => {
  const limits = ['300750', '688981', '830799'].map((c) => priceLimitOf(c, '测试', 10).limit);
  assert.ok(limits.every((l) => l !== 0.1));
});
