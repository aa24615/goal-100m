/**
 * middleware.parseIdParam —— 路径参数 ID 解析的单元测试
 *
 * 起因：旧实现用 `Number.isInteger(n) && n > 0` 校验，只判断「数学上是整数」而
 * 不做范围约束。`'99999999999999999999'` 被解析成 1e20，它是整数且大于 0，于是
 * 顺利通过校验；但 1e20 远超 PostgreSQL bigint 上限 9223372036854775807，下发 SQL
 * 后数据库抛 **22003（value "100000000000000000000" is out of range for type
 * bigint）**，被 errorHandler 兜成 **500 + 一条 ERROR 日志**。
 *
 * 实测复现路径（2026-10-29 本机验证，均为稳定复现）：
 *   GET /api/replay/99999999999999999999  -> 500
 *   GET /api/blind/99999999999999999999   -> 500
 * 修复后二者回落 400（「训练 ID 无效」/「回放会话 ID 非法」等业务拒绝），日志降级为 WARN。
 *
 * 覆盖四级优先级：
 *   P0 正常取值 · P3 边界条件 · P4 脏输入降级 · P5 缺陷回归防线
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdParam } from '../../src/middleware.js';
import { isDbInt, INT32_MAX } from '../../src/utils/num.js';

// PostgreSQL 类型上限：bigint 9223372036854775807、integer 2147483647。
// 库里 int4 / int8 混用，parseIdParam 必须同时对两者安全。
const PG_BIGINT_MAX = 9223372036854775807n;
const PG_INT_MAX = 2147483647n;

test('P0 · 常规正整数 ID 原样解析（修复前后行为完全一致）', () => {
  assert.equal(parseIdParam('1'), 1);
  assert.equal(parseIdParam('42'), 42);
  assert.equal(parseIdParam(42), 42);
  assert.equal(parseIdParam('1000000'), 1000000);
  // UUID/短 ID 之外的自增主键在可预见范围内的取值
  assert.equal(parseIdParam('999999999'), 999999999);
});

test('P0 · 返回值为 number 类型，可直接作为 pg 参数下发', () => {
  assert.equal(typeof parseIdParam('7'), 'number');
  assert.ok(Number.isSafeInteger(parseIdParam('7')));
});

test('P3 · 取值上界为 int4 上限 2147483647 —— 同时对 int4 与 int8 列都安全', () => {
  assert.equal(parseIdParam('2147483647'), 2147483647, 'int4 上界应放行');
  assert.equal(parseIdParam('2147483648'), null, 'int4 上界 +1 应拒绝');
  // 且该上界必须落在 bigint 区间内，才能保证「通过即可安全下发任意 ID 列」
  assert.ok(PG_INT_MAX < PG_BIGINT_MAX);
  assert.ok(INT32_MAX < Number.MAX_SAFE_INTEGER);
});

test('P3 · 超过整型列的输入一律拒绝（含 2^53 这一首个不安全整数）', () => {
  assert.equal(parseIdParam('9007199254740992'), null, '2^53 不是安全整数');
  assert.equal(parseIdParam('99999999999999999999'), null, '1e20 —— 旧实现漏网的取值');
  assert.equal(parseIdParam('1e20'), null);
  assert.equal(parseIdParam('1e309'), null, 'Infinity');
  assert.equal(parseIdParam(-Infinity), null);
  assert.equal(parseIdParam('-99999999999999999999'), null);
});

test('P4 · 脏输入统一降级为 null —— 22P02「invalid input syntax」的回归防线', () => {
  assert.equal(parseIdParam('abc'), null);
  assert.equal(parseIdParam('NaN'), null);
  assert.equal(parseIdParam(''), null);
  assert.equal(parseIdParam(' '), null);
  assert.equal(parseIdParam('1;DROP TABLE users'), null);
  assert.equal(parseIdParam(null), null);
  assert.equal(parseIdParam(undefined), null);
  assert.equal(parseIdParam({}), null);

  // 说明：Express 的 req.params.* 恒为字符串，数组/对象在真实链路中不可达，
  // 这里只为固化「解析出错时降级为 null、绝不把脏值下发 SQL」这一契约。
  // 注：Number([1]) === 1，故单元素数组会像 '1' 一样通过 —— 属不可达分支，不做额外类型门禁。
});

test('P4 · 非正与非整数：0 / 负数 / 小数全部拒绝', () => {
  assert.equal(parseIdParam('0'), null);
  assert.equal(parseIdParam('-1'), null);
  assert.equal(parseIdParam('-0'), null);
  assert.equal(parseIdParam('1.5'), null);
  assert.equal(parseIdParam('0.5'), null);
  assert.equal(parseIdParam('1.0'), 1, '1.0 在数学上等于 1，保持放行');
});

test('P5 · 缺陷回归：所有能通过校验的值都必须能安全写入 bigint 列', () => {
  const candidates = [
    '1',
    '42',
    '999999999',
    '2147483647', // int4 上界
    '2147483648', // int4 上界 +1
    '9007199254740991', // MAX_SAFE_INTEGER
    '99999999999999999999', // 1e20 —— 本次修复的靶心
    '9223372036854775807', // bigint 上限
    '9223372036854775808', // bigint 上限 +1
    '1e309',
    'abc',
    '-1',
    '0',
    '1.5',
    '',
    null,
    undefined,
  ];
  for (const raw of candidates) {
    const v = parseIdParam(raw);
    if (v === null) continue;
    assert.ok(Number.isSafeInteger(v), `${raw} → ${v} 不是安全整数`);
    assert.ok(BigInt(v) <= PG_INT_MAX, `${raw} → ${v} 超出 int4 区间，会触发 22003`);
  }
  // 反向确认：三条实测复现路径全部被拦下（防止修复被回退）
  assert.equal(parseIdParam('99999999999999999999'), null);
  assert.equal(parseIdParam('2147483648'), null);
});

test('P5 · isDbInt：整数且落在 int4 区间才为真 —— 22003 的通用判定', () => {
  assert.equal(isDbInt(1), true);
  assert.equal(isDbInt(0), true, '0 是合法 int4 值');
  assert.equal(isDbInt(-5), true, '负数本身不越界');
  assert.equal(isDbInt(2147483647), true);
  assert.equal(isDbInt(-2147483647), true);
  assert.equal(isDbInt(2147483648), false, '超出 int4 上界');
  assert.equal(isDbInt(99999999999999999999), false, '1e20 —— /replay/compare 的靶心');
  assert.equal(isDbInt(Infinity), false);
  assert.equal(isDbInt(NaN), false);
  assert.equal(isDbInt('abc'), false, '非数值直接为假');
});

test('P5 · isDbInt 与 parseIdParam 的差集：前者放行 0/负数，后者只放行正整数 ID', () => {
  assert.equal(isDbInt(0), true);
  assert.equal(parseIdParam('0'), null);
  assert.equal(isDbInt(-1), true);
  assert.equal(parseIdParam('-1'), null);
});
