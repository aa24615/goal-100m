/**
 * 数据库入参边界守卫 —— 本轮 4 项 500 修复的回归测试
 *
 * 起因（2026-10-30 日志分析）：生产侧自然流量 0 ERROR，靠「全路由扫描 +
 * 查询参数模糊测试」主动挖出 4 条稳定复现的 5xx。它们同属一类缺陷：
 * **入参只判「是不是数字/整数」，不判「是否在 PostgreSQL 能接受的范围内」**，
 * 越界值原样下发 SQL，被 PG 拒绝后由 errorHandler 兜成 500。
 *
 *   F-01 /stocks/:code/daily?startSeq&endSeq  → 22003（integer out of range）
 *   F-02 POST /blind/start  startSeq/endSeq   → 22003（integer out of range）
 *   F-03 /replay/history?limit=1.5            → 22P02（bigint: "1.5"）
 *   F-04 /review/benchmark?days=Infinity      → 22007 / 22015（interval）
 *
 * 覆盖四级优先级：
 *   P0 合法取值原样通过（证明修复没有改变正常行为）
 *   P3 越界取值被拒绝/收敛（原 500 的那批输入）
 *   P4 脏输入降级
 *   P5 与既有口径一致
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDbInt, clampLimit, INT32_MAX } from '../../src/utils/num.js';
import { normalizeBenchmarkDays } from '../../src/services/reviewService.js';

/* ---------------- F-01 / F-02：seq 区间必须落在 int4 内 ---------------- */

test('P0 · 真实 seq 区间（7024~8662）仍被 isDbInt 接受', () => {
  assert.equal(isDbInt(7024), true);
  assert.equal(isDbInt(8662), true);
  // 修复前 Number.isInteger 也能通过，修复后必须同样通过，否则合法请求会被误降级
  assert.equal(isDbInt(1), true);
});

test('P3 · 1e20 / 1e309 / Infinity 这类「数学上是整数」的超限值被 isDbInt 拒绝', () => {
  // 1e20 是 Number.isInteger 的漏网之鱼：它是整数，但远超 int4 上限
  assert.equal(Number.isInteger(1e20), true, '前提：旧判定确实会放行 1e20');
  assert.equal(isDbInt(1e20), false);
  assert.equal(isDbInt(Number('99999999999999999999')), false);
  assert.equal(isDbInt(Infinity), false);
  assert.equal(isDbInt(NaN), false);
  assert.equal(isDbInt(2147483648), false, 'int4 上限 2147483647 之外一律拒绝');
  assert.equal(isDbInt(INT32_MAX), true, '边界值本身应被接受');
});

/* ---------------- F-03：LIMIT 必须是整数 ---------------- */

test('P0 · 合法 limit 原样返回', () => {
  assert.equal(clampLimit('20', 100, 20), 20);
  assert.equal(clampLimit('5', 100, 20), 5);
});

test('P3 · limit=1.5 取整为 1（原样下发会触发 22P02 bigint）', () => {
  assert.equal(clampLimit('1.5', 100, 20), 1);
  assert.equal(clampLimit(1.9, 100, 20), 1);
  // 旧写法 Math.max(1, Number('1.5') || 20) 会得到 1.5 —— 这正是 500 的来源
  assert.equal(Math.max(1, Number('1.5') || 20), 1.5, '前提：旧写法确实产出小数');
});

test('P4 · limit 脏输入与越界收敛到 [1,100]，缺省 20', () => {
  assert.equal(clampLimit('abc', 100, 20), 20);
  assert.equal(clampLimit('0', 100, 20), 20);
  assert.equal(clampLimit('-1', 100, 20), 1);
  assert.equal(clampLimit('1e309', 100, 20), 20, 'Infinity 回落缺省值');
  assert.equal(clampLimit('99999', 100, 20), 100, '超上限夹到 100');
});

/* ---------------- F-04：interval 天数必须有上界 ---------------- */

test('P0 · days 合法取值原样返回（含 0 = 全区间哨兵）', () => {
  assert.equal(normalizeBenchmarkDays(0), 0, '0 是全区间哨兵，不得被改写成缺省值');
  assert.equal(normalizeBenchmarkDays('0'), 0);
  assert.equal(normalizeBenchmarkDays(7), 7);
  assert.equal(normalizeBenchmarkDays(30), 30);
  assert.equal(normalizeBenchmarkDays(400), 400);
  assert.equal(normalizeBenchmarkDays(1.5), 1.5, 'PG 接受 1.5 days，保持原样');
});

test('P3 · days=Infinity / 1e309 / 超界整数被收敛，不再触发 22007 / 22015', () => {
  assert.equal(normalizeBenchmarkDays(Infinity), 30, '非有限值回落缺省值');
  assert.equal(normalizeBenchmarkDays(1e309), 30);
  assert.equal(normalizeBenchmarkDays('99999999999999999999'), 3650, '有限超界值夹到上界');
  assert.equal(normalizeBenchmarkDays(2147483648), 3650);
  assert.equal(normalizeBenchmarkDays(9223372036854775808), 3650);
});

test('P4 · days 脏输入回落缺省值', () => {
  assert.equal(normalizeBenchmarkDays('abc'), 30);
  assert.equal(normalizeBenchmarkDays(NaN), 30);
  assert.equal(normalizeBenchmarkDays(-1), 30);
  assert.equal(normalizeBenchmarkDays(undefined), 30);
});

test('P5 · 收敛结果一定可以直接拼进 interval（有限、非负、有上界）', () => {
  for (const raw of [0, 1, 7, 30, 400, 3650, 99999, 1e309, Infinity, -1, 'abc', NaN, '1e20', undefined]) {
    const d = normalizeBenchmarkDays(raw);
    assert.equal(Number.isFinite(d), true, `days=${String(raw)} 收敛后必须是有限数`);
    assert.equal(d >= 0, true, `days=${String(raw)} 收敛后必须非负`);
    assert.equal(d <= 3650, true, `days=${String(raw)} 收敛后必须不超过上界`);
  }
});
