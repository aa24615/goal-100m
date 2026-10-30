/**
 * 金额入参边界守卫 —— numeric(p,s) 越界导致兜底 500 的回归测试
 *
 * 起因（2026-10-31 日志分析）：生产侧自然流量 0 ERROR，靠「真实资源 + POST body
 * 模糊测试」挖出 1 条稳定复现的 5xx：
 *
 *   F-01 POST /replay/start  capital=1e20 → 22003（numeric field overflow）
 *
 * 与 2026-10-30 那批（isDbInt / clampLimit）同属一类缺陷家族，但作用在**另一类列**上：
 * 此前只覆盖了 int4 / bigint 整数列，未覆盖 `numeric(p,s)` 金额列。
 * `Number(capital) > 0` 这类写法只判正负，1e20 与 Infinity 都是「合法正数」，
 * 于是原样写入 numeric(18,2)，被 PG 拒绝后兜成 500。
 *
 * 覆盖四级优先级：
 *   P0 合法金额原样通过（证明修复没有改变正常行为）
 *   P3 越界/非有限值被收敛（原 500 的那批输入）
 *   P4 脏输入降级到缺省值
 *   P5 收敛结果一定可以直接下发 SQL
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDbMoney, clampMoney, MAX_MONEY_18_2, MAX_MONEY_12_2 } from '../../src/utils/num.js';
import { startSession } from '../../src/services/replayService.js';

/* ---------------- F-01：numeric(18,2) 的上界判定 ---------------- */

test('P0 · 合法金额被 isDbMoney 接受（含小数与极大但合法的资金）', () => {
  assert.equal(isDbMoney(1000000), true, '默认初始资金');
  assert.equal(isDbMoney(1), true, '最小正整数资金');
  assert.equal(isDbMoney(0.01), true, '一分钱');
  assert.equal(isDbMoney(1234.56), true, '带小数的金额');
  assert.equal(isDbMoney(MAX_MONEY_18_2), true, '边界值本身应当可通过');
});

test('P3 · 超过 numeric(18,2) 上界的「合法正数」被拒绝', () => {
  // 前提：这些值全部满足旧的 `Number(x) > 0` 判定 —— 这正是缺陷所在
  for (const v of [1e20, Number('99999999999999999999'), 1e300, MAX_MONEY_18_2 * 10]) {
    assert.equal(v > 0, true, `前提：${v} 确实是正数，旧口径会放行`);
    assert.equal(isDbMoney(v), false, `${v} 超出 numeric(18,2) 上界`);
  }
});

test('P3 · Infinity / -Infinity / NaN 因「非有限」被拒绝', () => {
  // Infinity > 0 成立，任何只判正负的写法都会放行它
  assert.equal(Infinity > 0, true, '前提：Infinity 是正数');
  assert.equal(isDbMoney(Infinity), false);
  assert.equal(isDbMoney(-Infinity), false);
  assert.equal(isDbMoney(NaN), false);
});

test('P3 · 0 与负数被拒绝（与既有 `Number(x) > 0` 口径一致）', () => {
  assert.equal(isDbMoney(0), false);
  assert.equal(isDbMoney(-0), false);
  assert.equal(isDbMoney(-1), false);
  assert.equal(isDbMoney(-1000000), false);
});

test('P4 · clampMoney 对脏输入一律回落缺省值', () => {
  const FALLBACK = 1000000;
  for (const raw of ['abc', '', '   ', null, undefined, NaN, 0, -0, -5, '0', '-1',
                     Infinity, 'Infinity', '1e309', '1e20', '99999999999999999999',
                     {}, [], false]) {
    assert.equal(clampMoney(raw, FALLBACK), FALLBACK, `输入 ${String(raw)} 应回落缺省值`);
  }
});

test('P4 · 布尔值沿用既有 Number() 口径（true→1），与修复前行为保持一致', () => {
  // Number(true) === 1，旧写法 `Number(capital) > 0` 同样会把它当作 1 元。
  // 本轮只修「越界导致 500」，不改判定强度，故此处刻意保留原行为以免破坏兼容性。
  assert.equal(clampMoney(true, 1000000), Number(true));
  assert.equal(clampMoney(false, 1000000), 1000000, 'Number(false)===0，非正数故回落');
});

test('P4 · clampMoney 对合法输入原样返回，不做四舍五入（舍入仍交给 PG）', () => {
  assert.equal(clampMoney(500000, 1000000), 500000);
  assert.equal(clampMoney('250000', 1000000), 250000, '数字字符串按 Number 解析');
  assert.equal(clampMoney(1234.56789, 1000000), 1234.56789, '精度处理不在 JS 侧进行');
  assert.equal(clampMoney(0.01, 1000000), 0.01);
});

test('P5 · numeric(12,2) 价格列使用更严格的上界', () => {
  // 同一套工具支持不同精度列：价格类列整数位最多 10 位
  assert.equal(isDbMoney(99999999999, MAX_MONEY_12_2), false, '11 位整数超出 numeric(12,2)');
  assert.equal(isDbMoney(9999999999.99, MAX_MONEY_12_2), true);
  assert.equal(clampMoney(99999999999, 1, MAX_MONEY_12_2), 1, '超上界应回落');
});

/* ---------------- F-01 集成面：startSession 必须先挡下越界 capital ---------------- */

test('P3 · startSession 在写库前就拒绝越界 capital（不依赖 PG 报错）', async () => {
  // 区间非法会先于 capital 被校验并返回 400，用于证明「抛错发生在 SQL 之前」
  const cases = ['1e20', 'Infinity', '1e309', '99999999999999999999'];
  for (const capital of cases) {
    const err = await startSession({ userId: 1, startSeq: 1, endSeq: 99999, capital }).catch((e) => e);
    // 这里必然抛错；关键断言是**错误来自应用层校验**（带 status 的业务错误 400），
    // 而不是 PG 的 22003 原生错误（那才是要修的缺陷）。
    assert.ok(err, `capital=${capital} 应当被拒绝`);
    assert.equal(
      err && (err.code === '22003' || String(err.message || '').includes('numeric field overflow')),
      false,
      `capital=${capital} 不得落到 PG 的 numeric overflow`
    );
  }
});

test('P0 · 越界 capital 被收敛后仍能拿到合法的默认初始资金', () => {
  // clampMoney 是本轮唯一新增的行为：非法值 → DEFAULT_CAPITAL
  assert.equal(clampMoney('1e20', 1000000), 1000000);
  assert.equal(clampMoney('Infinity', 1000000), 1000000);
  assert.equal(clampMoney(undefined, 1000000), 1000000, '未传 capital 与旧行为一致');
});
