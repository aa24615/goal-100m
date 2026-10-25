/**
 * RQ-86 每周训练周报 —— 单元测试
 *
 * 优先级覆盖：P2 主流程 · P3 边界与异常 · P5 口径同源
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWeekly, DAY_MS } from '../../src/services/weeklyReportService.js';
import { resolveTier } from '../../src/services/checkupService.js';

const NOW = new Date('2026-10-26T10:00:00+08:00');
const day = (n) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

function sessions(pairs) {
  // pairs: [几天前, 纪律执行率]
  return pairs.map(([daysAgo, rate], i) => ({
    id: i + 1,
    finishedAt: day(daysAgo),
    score: { disciplineRate: rate, returnPct: 1.2 },
    segmentTag: i % 2 === 0 ? 'volatile' : 'range',
  }));
}

/* ===================== P2 · 主流程 ===================== */

test('P2 · RQ-86 本周段数与上周段数分别统计', () => {
  const r = summarizeWeekly({ sessions: sessions([[1, 80], [2, 60], [9, 70]]), now: NOW });
  assert.equal(r.segments.thisWeek, 2, '1 天前 + 2 天前属于本周');
  assert.equal(r.segments.lastWeek, 1, '9 天前属于上周');
  assert.equal(r.segments.delta, 1);
});

test('P2 · RQ-86 纪律执行率给出本周/上周/变化值', () => {
  const r = summarizeWeekly({ sessions: sessions([[1, 80], [2, 60], [9, 70]]), now: NOW });
  assert.equal(r.discipline.thisWeek, 70, '(80+60)/2');
  assert.equal(r.discipline.lastWeek, 70);
  assert.equal(r.discipline.delta, 0);
  assert.match(r.discipline.note, /持平/);
});

test('P2 · RQ-86 纪律执行率上升/下降的文案方向正确', () => {
  const up = summarizeWeekly({ sessions: sessions([[1, 90], [9, 70]]), now: NOW });
  assert.equal(up.discipline.delta, 20);
  assert.match(up.discipline.note, /提升 20/);

  const down = summarizeWeekly({ sessions: sessions([[1, 50], [9, 70]]), now: NOW });
  assert.equal(down.discipline.delta, -20);
  assert.match(down.discipline.note, /下降 20/);
});

test('P2 · RQ-86 距下一档还差几笔，口径与体检单同源', () => {
  const checkup = { sampleSize: 75 };
  const r = summarizeWeekly({ sessions: sessions([[1, 80]]), checkup, now: NOW });
  const tier = resolveTier(75);
  assert.equal(r.nextTier.remaining, tier.remaining, '必须复用 resolveTier，不得另算一套门槛');
  assert.equal(r.nextTier.tierKey, tier.key);
  assert.match(r.nextTier.text, /还差 25 笔升到「绩效级」/);
});

test('P2 · RQ-86 周报按片段类型分组统计', () => {
  const r = summarizeWeekly({ sessions: sessions([[1, 80], [2, 60], [3, 70]]), now: NOW });
  assert.equal(r.segments.byTag.volatile, 2);
  assert.equal(r.segments.byTag.range, 1);
});

test('P2 · RQ-86 周报不含任何奖励承诺（合规硬约束）', () => {
  const r = summarizeWeekly({ sessions: sessions([[1, 80]]), now: NOW });
  // 免责声明里出现「奖励」是**否定式**表述，属预期；除它之外任何一处都不许提。
  const { disclaimer, ...rest } = r;
  const text = JSON.stringify(rest);
  for (const bad of ['奖励', '现金', '红包', '奖品', '兑换']) {
    assert.ok(!text.includes(bad), `周报正文不得出现「${bad}」`);
  }
  assert.match(disclaimer, /不承诺任何收益或奖励/, '免责声明必须明确否定奖励承诺');
});

/* ===================== P3 · 边界与异常 ===================== */

test('P3 · RQ-86 完全没有训练记录时为空态而非报错', () => {
  const r = summarizeWeekly({ sessions: [], now: NOW });
  assert.equal(r.empty, true);
  assert.equal(r.segments.thisWeek, 0);
  assert.equal(r.discipline.delta, null, '无数据不得返回 0 变化');
  assert.match(r.discipline.note, /暂不给出变化/);
});

test('P3 · RQ-86 只有上周数据时不给出「下降 100%」这类误导结论', () => {
  const r = summarizeWeekly({ sessions: sessions([[9, 70]]), now: NOW });
  assert.equal(r.segments.thisWeek, 0);
  assert.equal(r.segments.lastWeek, 1);
  assert.equal(r.discipline.thisWeek, null);
  assert.equal(r.discipline.delta, null, '本周无数据 ≠ 本周 0%');
});

test('P3 · RQ-86 脏入参（null / 非法日期 / 非数组）不抛错', () => {
  assert.doesNotThrow(() => summarizeWeekly(null));
  assert.doesNotThrow(() => summarizeWeekly({}));
  assert.doesNotThrow(() => summarizeWeekly({ sessions: null, now: NOW }));
  assert.doesNotThrow(() =>
    summarizeWeekly({
      sessions: [{ finishedAt: 'not-a-date', score: null }, { finishedAt: null }, null],
      now: NOW,
    })
  );
  const r = summarizeWeekly({ sessions: [{ finishedAt: 'not-a-date', score: null }], now: NOW });
  assert.equal(r.segments.thisWeek, 0, '非法日期不得被计入本周');
});

test('P3 · RQ-86 无 checkup 时按 0 笔计算档位，不返回 NaN', () => {
  const r = summarizeWeekly({ sessions: sessions([[1, 80]]), checkup: null, now: NOW });
  assert.equal(r.nextTier.sampleSize, 0);
  assert.equal(r.nextTier.remaining, 50);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('NaN'));
  assert.ok(!text.includes('Infinity'));
});

test('P3 · RQ-86 基准时间为非法值时回退到当前时间，不抛错', () => {
  assert.doesNotThrow(() => summarizeWeekly({ sessions: sessions([[1, 80]]), now: 'oops' }));
  assert.doesNotThrow(() => summarizeWeekly({ sessions: sessions([[1, 80]]), now: null }));
});

/* ===================== P5 · 兼容性与回归 ===================== */

test('P5 · RQ-86 窗口天数可配置，且窗口边界不重叠', () => {
  const r14 = summarizeWeekly({ sessions: sessions([[10, 70]]), now: NOW, weekDays: 14 });
  assert.equal(r14.window.days, 14);
  assert.equal(r14.segments.thisWeek, 1, '10 天前在 14 天窗口内');

  const r7 = summarizeWeekly({ sessions: sessions([[10, 70]]), now: NOW, weekDays: 7 });
  assert.equal(r7.segments.thisWeek, 0);
  assert.equal(r7.segments.lastWeek, 1);
});

test('P5 · RQ-86 档位口径随 resolveTier 变化自动同步（不存在第二套门槛）', () => {
  for (const n of [0, 50, 100, 200, 999]) {
    const r = summarizeWeekly({ sessions: [], checkup: { sampleSize: n }, now: NOW });
    assert.equal(r.nextTier.remaining, resolveTier(n).remaining);
    assert.equal(r.nextTier.tierKey, resolveTier(n).key);
  }
  assert.equal(summarizeWeekly({ sessions: [], checkup: { sampleSize: 500 }, now: NOW }).nextTier.remaining, 0);
});
