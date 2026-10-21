import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcFees, feeConfig, DAILY_LIMIT, MIN_COMMISSION, COMMISSION_RATE, STAMP_RATE, TRANSFER_RATE } from '../../src/fees.js';

// P0：费用计算是交易链路的正确性地基，错误会直接导致用户资产算错
test('P0 买入费用 = 佣金(最低5元) + 过户费，不含印花税', () => {
  const amount = 10000;
  const fee = calcFees(amount, 'BUY');
  const commission = Math.max(MIN_COMMISSION, amount * COMMISSION_RATE); // 3 < 5 → 取 5
  const transfer = amount * TRANSFER_RATE; // 0.1
  assert.equal(fee, Math.round((commission + transfer) * 100) / 100);
  assert.ok(fee >= MIN_COMMISSION);
});

test('P0 卖出费用额外包含印花税(万5)', () => {
  const amount = 10000;
  const fee = calcFees(amount, 'SELL');
  const commission = Math.max(MIN_COMMISSION, amount * COMMISSION_RATE);
  const stamp = amount * STAMP_RATE; // 0.5
  const transfer = amount * TRANSFER_RATE;
  assert.equal(fee, Math.round((commission + stamp + transfer) * 100) / 100);
});

test('P1 大额买入佣金按比例收取，无最低佣金限制', () => {
  const amount = 1_000_000;
  const fee = calcFees(amount, 'BUY');
  const expect = Math.round(amount * COMMISSION_RATE * 100) / 100 + Math.round(amount * TRANSFER_RATE * 100) / 100;
  assert.equal(fee, expect);
});

// P2：前端拉取的费率结构必须与后端规则一致
test('P2 feeConfig 返回完整且一致的费率结构', () => {
  const c = feeConfig();
  assert.equal(c.commissionRate, COMMISSION_RATE);
  assert.equal(c.stampRate, STAMP_RATE);
  assert.equal(c.transferRate, TRANSFER_RATE);
  assert.equal(c.minCommission, MIN_COMMISSION);
  assert.equal(c.dailyLimit, DAILY_LIMIT);
});
