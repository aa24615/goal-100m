/**
 * v12 入参守卫回归测试 —— 两类「夹而不整 / 只判正数」导致的兜底 500
 *
 * 起因（2026-11-01 日志分析）：生产自然流量仍近乎为零（全天仅 `/api/health` 与
 * 1 次 `/api/public/access`），日志 0 ERROR。本轮靠「全路由自动派生 + 真实资源句柄」
 * 的模糊测试挖出 2 个稳定复现、1 个潜伏的 5xx：
 *
 *   F-01 POST /api/blind/:id/decision  stopPlan=1e20     → 22003 numeric field overflow（500）
 *   F-02 GET  /api/blind/export?limit=1.5                → 22P02  bigint "1.5"（500）
 *   F-03 POST /api/analytics/integrity/purge?batch=1.5   → 22P02（潜伏：库内暂无重复 dedupe_key，
 *                                                            DELETE 分支未被执行）
 *
 * 与 10-30 / 10-31 两轮同属「入参未收敛到列类型可接受范围」这一缺陷家族，但作用在
 * **两个新的失效模式**上：
 *   1) 金额列只判 `> 0` 不判上界（10-31 修的是 numeric(18,2)，本轮补 numeric(12,2)）；
 *   2) 分页参数「夹而不整」——`Math.min(max, Math.min(1, x))` 没有 `Math.floor`，
 *      小数原样进 SQL 的 LIMIT。
 * 第 2 类是 v12 新代码**重新手写夹取**时漏掉取整引入的回归，第 7 轮的 clampInt 已含
 * Math.floor，本轮统一改为复用它。
 *
 * 覆盖四级优先级：
 *   P0 合法入参结果零变化（证明修复没有改变正常行为）
 *   P3 原 500 的那批输入被收敛
 *   P4 脏输入降级到缺省值
 *   P5 下发 SQL 的参数一定是整数 / 在列类型范围内
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInt, clampLimit, MAX_MONEY_12_2 } from '../../src/utils/num.js';
import { normalizeStopPlan } from '../../src/services/blindService.js';
import { exportableSessions } from '../../src/services/dataRetentionService.js';
import { scanDuplicates, purgeDuplicates } from '../../src/services/telemetryIntegrityService.js';

/* ---------------- F-01：numeric(12,2) 计划止损的上界判定 ---------------- */

test('P0 · 合法止损金额原样通过（不改变已有行为）', () => {
  assert.equal(normalizeStopPlan(10), 10, '整数止损');
  assert.equal(normalizeStopPlan(1234.56), 1234.56, '带两位小数的止损');
  assert.equal(normalizeStopPlan(0.01), 0.01, '一分钱');
  assert.equal(normalizeStopPlan(MAX_MONEY_12_2), MAX_MONEY_12_2, '边界值本身应可通过');
  assert.equal(normalizeStopPlan('88.8'), 88.8, '字符串数字按既有口径仍被接受');
});

test('P3 · 超过 numeric(12,2) 上界的「合法正数」被收敛为 null', () => {
  // 前提：这些值全部满足旧的 `Number.isFinite(v) && v > 0` 判定 —— 这正是缺陷所在
  for (const v of [1e20, Number('99999999999999999999'), 1e300, MAX_MONEY_12_2 * 10]) {
    assert.equal(Number.isFinite(v) && v > 0, true, `前提：${v} 确实是正数，旧口径会放行`);
    assert.equal(normalizeStopPlan(v), null, `${v} 超出 numeric(12,2) 上界，应回落 null`);
  }
});

test('P4 · Infinity / NaN / 0 / 负数 / 脏输入一律回落 null', () => {
  assert.equal(Infinity > 0, true, '前提：Infinity 是正数，只判正负的写法会放行它');
  assert.equal(normalizeStopPlan(Infinity), null);
  assert.equal(normalizeStopPlan(-Infinity), null);
  assert.equal(normalizeStopPlan(NaN), null);
  assert.equal(normalizeStopPlan(0), null, '0 与「没写止损」等价');
  assert.equal(normalizeStopPlan(-5), null);
  for (const v of ['abc', '', '   ', null, undefined, {}, []]) {
    assert.equal(normalizeStopPlan(v), null, `${String(v)} 应回落 null`);
  }
  // 既有行为刻意保留：`Number(true) === 1`，与第 9 轮 clampMoney 的口径一致 ——
  // 修的是「越界」，不是「类型强度」，贸然收紧会改变合法客户端的结果。
  assert.equal(normalizeStopPlan(true), 1, 'Number(true)===1 属既有行为，不提高判定强度');
});

test('P5 · 返回值一定可直接写入 numeric(12,2)', () => {
  const samples = [10, 0.01, '88.8', 1e20, Infinity, -1, 'abc', null];
  for (const v of samples) {
    const out = normalizeStopPlan(v);
    if (out === null) continue;
    assert.equal(Number.isFinite(out), true, `${v} → ${out} 必须是有限数`);
    assert.ok(out > 0 && out <= MAX_MONEY_12_2, `${v} → ${out} 必须落在 (0, ${MAX_MONEY_12_2}]`);
  }
});

/* ---------------- F-02：导出接口的 LIMIT 必须取整 ---------------- */

test('P3 · 小数 limit 被取整而不是原样下发（原 22P02 的复现输入）', () => {
  assert.equal(clampLimit(1.5, 2000, 500), 1, '1.5 → 1，而不是把 "1.5" 交给 SQL');
  assert.equal(clampLimit('1.5', 2000, 500), 1);
  assert.equal(clampLimit('0.4', 2000, 500), 1, '小于 1 的正数夹到下限 1');
});

test('P0/P4 · limit 的合法值与脏值行为不变', () => {
  assert.equal(clampLimit(10, 2000, 500), 10, '合法值零变化');
  assert.equal(clampLimit(1, 2000, 500), 1, '下限');
  assert.equal(clampLimit(1e20, 2000, 500), 2000, '超界夹到上限');
  assert.equal(clampLimit(0, 2000, 500), 500, '0 取缺省值（与旧 `|| 500` 一致）');
  assert.equal(clampLimit('abc', 2000, 500), 500);
  assert.equal(clampLimit(undefined, 2000, 500), 500);
});

test('P5 · exportableSessions 下发的 LIMIT 一定是整数', async () => {
  for (const v of ['1.5', 1.5, 10, 'abc', 1e20, 0]) {
    const seen = [];
    await exportableSessions(
      { userId: 3 },
      {
        limit: v,
        queryFn: async (sql, params) => {
          seen.push(params);
          return { rows: [] };
        },
      }
    );
    assert.equal(seen.length, 1, `limit=${v} 应只执行一次查询`);
    const lim = seen[0][1];
    assert.equal(Number.isInteger(lim), true, `limit=${v} 下发的 LIMIT=${lim} 必须是整数`);
    assert.ok(lim >= 1 && lim <= 2000, `LIMIT=${lim} 必须落在 [1,2000]`);
  }
});

/* ---------------- F-03：purgeDuplicates 的 batch 必须取整 ---------------- */

test('P3 · 小数 batch 被取整（潜伏缺陷：当前库内无重复 dedupe_key，分支尚未执行）', () => {
  assert.equal(clampInt(1.5, 1, 50000, 5000), 1);
  assert.equal(clampInt('1.5', 1, 50000, 5000), 1);
  assert.equal(clampInt(0, 1, 50000, 5000), 5000, '0 取缺省值');
  assert.equal(clampInt(1e20, 1, 50000, 5000), 50000, '超界夹到上限');
  assert.equal(clampInt('abc', 1, 50000, 5000), 5000);
});

test('P5 · purgeDuplicates 下发的 LIMIT 一定是整数', async () => {
  for (const v of ['1.5', 1.5, 100, 0, 'abc']) {
    const seen = [];
    // probe 返回「有重复」，让代码走到真正的 DELETE 分支
    await purgeDuplicates({
      dryRun: false,
      batch: v,
      queryFn: async (sql, params) => {
        seen.push(params);
        if (/SELECT COUNT/.test(sql)) return { rows: [{ c: 5 }] };
        return { rowCount: 0 };
      },
    });
    const deleteCall = seen[seen.length - 1];
    const lim = deleteCall[0];
    assert.equal(Number.isInteger(lim), true, `batch=${v} 下发的 LIMIT=${lim} 必须是整数`);
    assert.ok(lim >= 1 && lim <= 50000, `LIMIT=${lim} 必须落在 [1,50000]`);
  }
});

test('P5 · scanDuplicates 下发的 LIMIT 一定是整数', async () => {
  for (const v of ['1.5', 1.5, 5, 0]) {
    const seen = [];
    await scanDuplicates({
      days: 30,
      top: v,
      queryFn: async (sql, params) => {
        seen.push(params);
        return { rows: [] };
      },
    });
    const lim = seen[0][1];
    assert.equal(Number.isInteger(lim), true, `top=${v} 下发的 LIMIT=${lim} 必须是整数`);
    assert.ok(lim >= 1 && lim <= 200, `LIMIT=${lim} 必须落在 [1,200]`);
  }
});
