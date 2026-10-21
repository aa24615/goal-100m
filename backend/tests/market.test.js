import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharesOf, hashOf } from '../src/market.js';

// P1：股本估算用于市值加权与成交量，必须确定且落在合理区间
test('P1 sharesOf 对同一代码确定性一致', () => {
  const a = sharesOf('SH600000', 10);
  const b = sharesOf('SH600000', 10);
  assert.equal(a, b);
});

test('P1 sharesOf 市值落在 80亿~370亿 区间且取整到万股', () => {
  for (const code of ['SH600000', 'SZ000001', 'BJ830799', 'SH601318']) {
    const shares = sharesOf(code, 10);
    const cap = shares * 10;
    assert.ok(cap >= 8e9 && cap <= 3.7e10, `${code} 市值越界: ${cap}`);
    assert.equal(shares % 10000, 0, `${code} 应取整到万股`);
  }
});

test('P1 hashOf 结果落在 [0,1000)', () => {
  const h = hashOf('SH600000');
  assert.ok(Number.isInteger(h) && h >= 0 && h < 1000, `hashOf 越界: ${h}`);
});
