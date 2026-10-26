/**
 * RQ-104 周报与达标提示站内推送 —— 单元测试
 *
 * 优先级模型：
 *   P0 核心主流程：达标提示与周报提示都能生成，且出现一次、可关闭
 *   P1 差异化功能：周报按自然周去重、无数据时给出「先去做一段」而不是空白
 *   P3 边界与异常：null 入参、脏 dismissed、非法日期
 *   P4 性能：大量已关闭 key 不退化
 *   P5 兼容性与回归：合规硬约束（不承诺奖励）、key 结构稳定
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInbox, weekKeyOf } from '../../src/services/notificationService.js';

const NOW = '2026-10-27T02:00:00.000Z';

const WEEKLY = {
  window: { days: 7, from: '2026-10-20', to: '2026-10-27' },
  segments: { thisWeek: 3, lastWeek: 1, delta: 2, byTag: { trend: 2, range: 1 } },
  discipline: { thisWeek: 80, lastWeek: 70, delta: 10, note: '纪律执行率较上周提升 10 个百分点。' },
  nextTier: { tierLabel: '行为级', remaining: 20, text: '还差 20 笔升到「绩效级」档' },
  disclaimer: '本训练周报基于模拟交易行为统计，不构成投资建议，不承诺任何收益或奖励。',
};

/* ===================== P0 · RQ-104 达标提示 ===================== */

test('P0 · RQ-104 达标当日生成一条可关闭的提示', () => {
  const inbox = buildInbox({
    checkup: {
      sampleSize: 50,
      milestone: {
        justReached: true,
        tierKey: 'behavior',
        tierLabel: '行为级',
        message: '已达成 50 笔，可信度升到「行为级」档。',
        cannot: '仍然不能拿它做：策略层面的期望值结论。',
      },
    },
    weekly: WEEKLY,
    now: NOW,
  });
  const m = inbox.items.find((i) => i.kind === 'milestone');
  assert.ok(m, '达标提示必须出现');
  assert.equal(m.dismissible, true, '提示必须可关闭');
  assert.equal(m.once, true, '只出现一次');
  assert.match(m.title, /行为级/);
  assert.ok(m.key.startsWith('milestone:'));
});

test('P0 · RQ-104 未达标时不生成达标提示', () => {
  const inbox = buildInbox({
    checkup: { sampleSize: 51, milestone: { justReached: false } },
    weekly: WEEKLY,
    now: NOW,
  });
  assert.equal(inbox.items.find((i) => i.kind === 'milestone'), undefined);
});

test('P0 · RQ-104 已关闭的提示不再出现（关闭状态由前端回传）', () => {
  const checkup = {
    sampleSize: 50,
    milestone: { justReached: true, tierKey: 'behavior', tierLabel: '行为级', message: 'x', cannot: 'y' },
  };
  const first = buildInbox({ checkup, weekly: WEEKLY, now: NOW });
  const key = first.items.find((i) => i.kind === 'milestone').key;

  const second = buildInbox({ checkup, weekly: WEEKLY, now: NOW, dismissed: [key] });
  assert.equal(second.items.find((i) => i.kind === 'milestone'), undefined);
  assert.ok(second.dismissed.includes(key));
});

/* ===================== P0 · RQ-104 周报提示 ===================== */

test('P0 · RQ-104 每周生成一条周报提示，含段数与纪律执行率变化', () => {
  const inbox = buildInbox({ checkup: null, weekly: WEEKLY, now: NOW });
  const w = inbox.items.find((i) => i.kind === 'weekly');
  assert.ok(w);
  assert.match(w.body, /本周 3 段/);
  assert.match(w.body, /提升 10 个百分点/);
  assert.match(w.body, /还差 20 笔/);
  assert.ok(w.action, '周报提示要给一个「去做一次训练」的出口');
  assert.equal(w.action.path, '/blind');
});

test('P0 · RQ-104 同一周内重复调用只出现一条周报提示（key 按自然周）', () => {
  const a = buildInbox({ checkup: null, weekly: WEEKLY, now: '2026-10-27T02:00:00.000Z' });
  const b = buildInbox({ checkup: null, weekly: WEEKLY, now: '2026-10-28T02:00:00.000Z' });
  // 2026-10-27 与 10-28 属于同一 ISO 周
  const ka = a.items.find((i) => i.kind === 'weekly').key;
  const kb = b.items.find((i) => i.kind === 'weekly').key;
  assert.equal(ka, kb);
  const withDismiss = buildInbox({ checkup: null, weekly: WEEKLY, now: '2026-10-28T02:00:00.000Z', dismissed: [ka] });
  assert.equal(withDismiss.items.find((i) => i.kind === 'weekly'), undefined);
});

/* ===================== P1 · RQ-104 空态处理 ===================== */

test('P1 · RQ-104 本周无训练时给出「先做一段」而不是空白或 0% 断言', () => {
  const inbox = buildInbox({
    checkup: null,
    weekly: { ...WEEKLY, segments: { thisWeek: 0, lastWeek: 0 }, discipline: { note: '本周或上周没有可比的纪律执行率数据，暂不给出变化。' } },
    now: NOW,
  });
  const w = inbox.items.find((i) => i.kind === 'weekly');
  assert.match(w.title, /还没有训练记录/);
  assert.match(w.body, /做一段盲测/);
  assert.ok(!/\d+%/.test(w.body), '空态不得出现百分比断言');
});

/* ===================== P3 · RQ-104 边界与异常 ===================== */

test('P3 · RQ-104 null / 脏入参不抛错', () => {
  for (const bad of [null, undefined, {}, { checkup: null, weekly: null }, { dismissed: 'x' }]) {
    const inbox = buildInbox(bad);
    assert.ok(Array.isArray(inbox.items), `入参 ${String(bad)} 应返回数组`);
    assert.ok(typeof inbox.count === 'number');
  }
  assert.doesNotThrow(() => buildInbox());
});

test('P3 · RQ-104 非法基准时间回退，不产生 Invalid Date', () => {
  const inbox = buildInbox({ checkup: null, weekly: WEEKLY, now: 'not-a-date' });
  const w = inbox.items.find((i) => i.kind === 'weekly');
  assert.ok(w);
  assert.ok(!w.createdAt.includes('Invalid'));
  assert.ok(!Number.isNaN(new Date(w.createdAt).getTime()));
});

test('P3 · RQ-104 dismissed 含非字符串 / null 时不抛错', () => {
  const inbox = buildInbox({ checkup: null, weekly: WEEKLY, now: NOW, dismissed: [null, 123, {}, 'weekly:2026-W44'] });
  assert.ok(Array.isArray(inbox.items));
});

test('P3 · RQ-104 weekKeyOf 对脏入参返回合法周 key', () => {
  for (const bad of [null, undefined, 'abc']) {
    const k = weekKeyOf(bad);
    assert.match(k, /^\d{4}-W\d{2}$/, `入参 ${String(bad)} 的周 key 不合法：${k}`);
  }
});

/* ===================== P4 · RQ-104 性能 ===================== */

test('P4 · RQ-104 已关闭 key 达到 5000 条时仍然在预算内完成', () => {
  const dismissed = Array.from({ length: 5000 }, (_, i) => `milestone:behavior:${i}`);
  const t0 = Date.now();
  const inbox = buildInbox({ checkup: null, weekly: WEEKLY, now: NOW, dismissed });
  const ms = Date.now() - t0;
  assert.ok(inbox.count >= 0);
  assert.ok(ms < 500, `5000 条已关闭 key 耗时 ${ms}ms`);
});

/* ===================== P5 · RQ-104 兼容性与回归 ===================== */

test('P5 · RQ-104 提示不承诺任何实物或现金奖励（合规硬约束）', () => {
  const inbox = buildInbox({
    checkup: { sampleSize: 50, milestone: { justReached: true, tierKey: 'behavior', tierLabel: '行为级', message: 'm', cannot: 'c' } },
    weekly: WEEKLY,
    now: NOW,
  });
  // 只扫标题与正文：`cannot` / 免责声明里本就写着「不承诺任何奖励」，
  // 把否定句也算进来会让断言永远失败（等于什么都没守住）。
  const text = inbox.items.map((i) => `${i.title}${i.body}`).join('|');
  for (const word of ['奖励', '现金', '红包', '提现', '礼品', '抽奖']) {
    assert.ok(!text.includes(word), `提示标题/正文不得出现「${word}」`);
  }
});

test('P5 · RQ-104 提示 key 结构稳定（前端按 key 持久化已读状态）', () => {
  const inbox = buildInbox({ checkup: null, weekly: WEEKLY, now: NOW });
  for (const it of inbox.items) {
    assert.ok(it.key.includes(':'), `${it.kind} 的 key 需带类型前缀`);
    assert.equal(it.once, true);
    assert.equal(it.dismissible, true);
  }
  assert.match(WEEKLY.disclaimer, /不承诺任何收益或奖励/);
});
