import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableQty, dateStrOf, shToday } from '../src/routes/trade.js';

// 注意：availableQty 依赖 T1_ENABLED 常量（默认开启）。以下用例均在 T+1 开启下验证冻结逻辑。
// P0：可卖数量直接决定用户能否卖出，算错会导致超卖或无法平仓
test('P0 无当日买入冻结记录时全部可卖', () => {
  const row = { quantity: 100, t1_qty: 0, last_buy_date: null };
  assert.equal(availableQty(row), 100);
});

test('P0 当日买入部分被冻结（不可卖）', () => {
  const row = { quantity: 100, t1_qty: 60, last_buy_date: shToday() };
  assert.equal(availableQty(row), 40);
});

test('P0 冻结量超过持仓数量时返回 0（不为负）', () => {
  const row = { quantity: 30, t1_qty: 60, last_buy_date: shToday() };
  assert.equal(availableQty(row), 0);
});

// P1：历史买入不应被冻结
test('P1 非当日买入全部可卖', () => {
  const row = { quantity: 100, t1_qty: 60, last_buy_date: '2000-01-01' };
  assert.equal(availableQty(row), 100);
});

// P1：时区处理必须与快照/排行榜一致（北京时间）
test('P1 dateStrOf 将 UTC Date 正确转为北京时间 YYYY-MM-DD', () => {
  const d = new Date('2026-10-21T02:00:00Z'); // 北京 10:00 同日
  assert.equal(dateStrOf(d), '2026-10-21');
  const late = new Date('2026-10-21T18:00:00Z'); // 北京次日 02:00
  assert.equal(dateStrOf(late), '2026-10-22');
});
