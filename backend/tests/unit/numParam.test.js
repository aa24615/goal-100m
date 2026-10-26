/**
 * utils/num.js clampInt —— 查询参数收敛的单元测试
 *
 * 起因：分页/限流参数此前只夹一边（Math.max(1, x) 或 Math.min(50, x)），
 * 负数与 Infinity 会原样进 SQL 的 LIMIT/OFFSET，被 PostgreSQL 拒绝后兜成 500
 * （2201W「LIMIT must not be negative」/ 22P02「invalid input syntax for type
 * bigint: "Infinity"」）。这里把该缺陷做成回归测试，防止再次退化。
 *
 * 覆盖四级优先级：
 *   P0 正常取值 · P3 边界条件 · P4 脏输入降级 · P5 与既有口径一致
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInt, clampLimit } from '../../src/utils/num.js';

const P_MAX = 1000000;

test('P0 · 区间内的合法值原样返回', () => {
  assert.equal(clampInt('10', 1, 50, 20), 10);
  assert.equal(clampInt(10, 1, 50, 20), 10);
  assert.equal(clampInt('1', 1, 50, 20), 1);
  assert.equal(clampInt('50', 1, 50, 20), 50);
});

test('P0 · 超出上界的值收敛到 max（不再把越界值下发 SQL）', () => {
  assert.equal(clampInt('9999', 1, 50, 20), 50);
  assert.equal(clampInt(1e309, 1, 50, 20), 20, 'Infinity 视为无效输入而非 Infinity');
});

test('P0 · 负数收敛到 min —— 2201W「LIMIT must not be negative」的回归防线', () => {
  assert.equal(clampInt('-5', 1, 50, 20), 1);
  assert.equal(clampInt(-1, 1, 50, 20), 1);
  assert.equal(clampLimit(-3, 200, 50), 1);
});

test('P0 · Infinity 走 fallback —— 22P02「invalid input syntax for bigint: Infinity」的回归防线', () => {
  assert.equal(clampInt('1e309', 1, P_MAX, 1), 1);
  assert.equal(clampInt(Infinity, 1, 50, 20), 20);
  assert.equal(clampInt(-Infinity, 1, 50, 20), 20);
});

test('P3 · 与既有 Number(x) || fallback 口径一致：0 / 空串 / null / undefined 取 fallback', () => {
  assert.equal(clampInt(0, 1, 50, 20), 20);
  assert.equal(clampInt('', 1, 50, 20), 20);
  assert.equal(clampInt(null, 1, 50, 20), 20);
  assert.equal(clampInt(undefined, 1, 50, 20), 20);
  assert.equal(clampInt('abc', 1, 50, 20), 20);
  assert.equal(clampInt(NaN, 1, 50, 20), 20);
});

test('P3 · 小数向下取整后仍落在区间内（不会产出 0.5 这类非法 LIMIT）', () => {
  assert.equal(clampInt('3.7', 1, 50, 20), 3);
  assert.equal(clampInt('0.5', 1, 50, 20), 1);
});

test('P3 · 返回值恒为安全整数，可直接下发 SQL', () => {
  for (const raw of ['-5', '0', '1', '7', '1e309', 'abc', '', null, undefined, '3.7']) {
    const v = clampInt(raw, 1, 50, 20);
    assert.ok(Number.isSafeInteger(v), `${raw} → ${v} 不是安全整数`);
    assert.ok(v >= 1 && v <= 50, `${raw} → ${v} 越界`);
  }
});

test('P5 · clampLimit 是 clampInt 下界为 1 的语义化别名', () => {
  assert.equal(clampLimit('5', 200, 50), 5);
  assert.equal(clampLimit('0', 200, 50), 50);
  assert.equal(clampLimit('9999', 200, 50), 200);
  assert.equal(clampLimit('-1', 200, 50), 1);
});

test('P5 · 分页页码：page 为负被夹到 1，超大页码被夹到上界，OFFSET 不越界', () => {
  assert.equal(clampInt('-1', 1, P_MAX, 1), 1);
  assert.equal(clampInt('1e309', 1, P_MAX, 1), 1);
  assert.ok(clampInt('1e309', 1, P_MAX, 1) * 50 <= Number.MAX_SAFE_INTEGER);
});
