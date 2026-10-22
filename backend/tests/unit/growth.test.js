import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceStreak, GUIDE_STEPS, TASK_DEFS, MILESTONES } from '../../src/services/onboardingService.js';
import { buildAbilityRadar, RADAR_DIMS } from '../../src/services/abilityService.js';
import { toCsv, transactionsCsv, roundsCsv, reviewHtml, buildShareCard } from '../../src/services/exportService.js';
import { resolveDuration, DURATION_OPTIONS } from '../../src/services/roomService.js';
import { isValidEvent, EVENTS } from '../../src/services/analyticsService.js';

// 成长体系 / 能力画像 / 导出 / 房间赛 / 埋点（RQ-15、RQ-24、RQ-31、RQ-32、RQ-20、RQ-35）

/* ---------------- RQ-15 连续练习 ---------------- */
test('P1 首次打卡从 1 天开始', () => {
  const s = advanceStreak({ current: 0, best: 0, lastDate: null }, '2026-10-22');
  assert.deepEqual(s, { current: 1, best: 1, lastDate: '2026-10-22', repeated: false });
});

test('P1 连续打卡累加，断签重置为 1', () => {
  const s = advanceStreak({ current: 3, best: 5, lastDate: '2026-10-21' }, '2026-10-22');
  assert.equal(s.current, 4);
  assert.equal(s.best, 5);

  const broke = advanceStreak({ current: 9, best: 9, lastDate: '2026-10-15' }, '2026-10-22');
  assert.equal(broke.current, 1);
  assert.equal(broke.best, 9); // 历史最佳不被覆盖
});

test('P1 同一天重复打卡不累加', () => {
  const s = advanceStreak({ current: 4, best: 4, lastDate: '2026-10-22' }, '2026-10-22');
  assert.equal(s.repeated, true);
  assert.equal(s.current, 4);
});

test('P2 引导四步齐备且顺序固定', () => {
  assert.equal(GUIDE_STEPS.length, 4);
  assert.deepEqual(
    GUIDE_STEPS.map((s) => s.step),
    [1, 2, 3, 4]
  );
  assert.ok(GUIDE_STEPS.every((s) => s.title && s.desc));
  // 内容不含任何收益承诺
  assert.ok(!GUIDE_STEPS.some((s) => /稳赚|必涨|保证/.test(s.desc)));
});

test('P2 任务清单每项都有解锁目标，且 key 唯一', () => {
  assert.ok(TASK_DEFS.length >= 4);
  assert.equal(new Set(TASK_DEFS.map((t) => t.key)).size, TASK_DEFS.length);
  assert.ok(TASK_DEFS.every((t) => t.label && t.unlocks));
  assert.ok(MILESTONES.every((m) => typeof m.check === 'function'));
});

/* ---------------- RQ-24 能力雷达 ---------------- */
const TX = [
  { id: 1, stockCode: 'A', stockName: 'A股', type: 'BUY', quantity: 1000, price: 10, amount: 10000, fee: 5, realizedPnl: null, createdAt: '2026-10-01T10:00:00Z' },
  { id: 2, stockCode: 'A', stockName: 'A股', type: 'SELL', quantity: 1000, price: 12, amount: 12000, fee: 11, realizedPnl: 1978, createdAt: '2026-10-05T10:00:00Z' },
  { id: 3, stockCode: 'B', stockName: 'B股', type: 'BUY', quantity: 500, price: 20, amount: 10000, fee: 5, realizedPnl: null, createdAt: '2026-10-06T10:00:00Z' },
  { id: 4, stockCode: 'B', stockName: 'B股', type: 'SELL', quantity: 500, price: 18, amount: 9000, fee: 10, realizedPnl: -1010, createdAt: '2026-10-08T10:00:00Z' },
];

test('P1 雷达四维齐全，分数落在 0~100', () => {
  const r = buildAbilityRadar({
    transactions: TX,
    returnPct: 3,
    benchmarkPct: 1,
    equitySeries: [100000, 105000, 95000],
    initialCapital: 100000,
    currentAssets: 103000,
  });
  assert.equal(r.dimensions.length, RADAR_DIMS.length);
  for (const d of r.dimensions) {
    assert.ok(d.score >= 0 && d.score <= 100, `${d.label}=${d.score} 越界`);
  }
  assert.ok(r.overall >= 0 && r.overall <= 100);
  assert.equal(r.dimensions.map((d) => d.label).join(','), '择时,选股,风控,纪律');
});

test('P1 跑赢大盘时择时分高于跑输时', () => {
  const win = buildAbilityRadar({ transactions: TX, returnPct: 10, benchmarkPct: 0, initialCapital: 100000, currentAssets: 110000 });
  const lose = buildAbilityRadar({ transactions: TX, returnPct: -10, benchmarkPct: 0, initialCapital: 100000, currentAssets: 90000 });
  assert.ok(win.dimensions[0].score > lose.dimensions[0].score);
});

test('P2 无交易数据时雷达不返回 NaN', () => {
  const r = buildAbilityRadar({ transactions: [], returnPct: 0, benchmarkPct: 0, initialCapital: 100000 });
  for (const d of r.dimensions) assert.equal(Number.isNaN(d.score), false);
  assert.equal(Number.isNaN(r.overall), false);
});

test('P2 极端回撤下风控分被压到 0 但不出界', () => {
  const r = buildAbilityRadar({
    transactions: TX,
    returnPct: -50,
    benchmarkPct: 0,
    equitySeries: [100000, 200000, 50000],
    initialCapital: 100000,
  });
  const risk = r.dimensions.find((d) => d.key === 'risk');
  assert.equal(risk.score, 0);
});

/* ---------------- RQ-31 导出 ---------------- */
test('P1 CSV 带 BOM 且对逗号/引号/换行正确转义', () => {
  const csv = toCsv(['h1', 'h2'], [['a,b', 'c"d'], ['e\nf', 'g']]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"c""d"'));
  assert.ok(csv.includes('"e\nf"'));
});

test('P1 交易流水 CSV 表头与行数正确', () => {
  const csv = transactionsCsv(TX);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines.length, TX.length + 1);
  assert.match(lines[0], /成交时间/);
  assert.match(lines[1], /买入/);
});

test('P2 空数据导出只含表头', () => {
  const csv = transactionsCsv([]);
  assert.equal(csv.replace(/^\uFEFF/, '').split('\r\n').length, 1);
  const r = roundsCsv([]);
  assert.equal(r.replace(/^\uFEFF/, '').split('\r\n').length, 1);
});

test('P1 复盘 HTML 含免责声明，可直接打印为 PDF', () => {
  const html = reviewHtml({
    period: '30d',
    returnPct: 3.5,
    benchmarkPct: 1.2,
    excessPct: 2.3,
    report: { disclaimer: '不构成投资建议', traits: [{ label: '持仓偏短', detail: '平均 1 天' }], suggestions: ['设定最短持有期'] },
    scorecard: { winRate: 50, profitFactor: 1.5, maxDrawdown: 8, feeRatio: 0.4 },
    rounds: [],
  });
  assert.match(html, /不构成投资建议/);
  assert.match(html, /<html/);
  assert.match(html, /持仓偏短/);
});

test('P2 HTML 对用户输入做转义，防 XSS', () => {
  const html = reviewHtml({
    period: '<script>alert(1)</script>',
    report: { suggestions: ['<img onerror=alert(1)>'], traits: [] },
    scorecard: {},
    rounds: [],
  }, { displayName: '<b>x</b>' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img onerror'));
  assert.ok(html.includes('&lt;script&gt;'));
});

/* ---------------- RQ-32 分享卡脱敏 ---------------- */
test('P0 分享卡不含未脱敏身份信息', () => {
  const card = buildShareCard({
    displayName: '张三丰的测试账户',
    username: 'zhangsanfeng',
    returnPct: 12.3,
    excessPct: 5.6,
    radar: { overall: 70, dimensions: [{ label: '择时', score: 80 }] },
  });
  assert.ok(!JSON.stringify(card).includes('zhangsanfeng'), '原始用户名被泄露');
  assert.match(card.usernameMasked, /\*/);
  assert.ok(card.displayName.length <= 12);
  assert.equal(card.outcome, '跑赢大盘');
  assert.match(card.disclaimer, /不构成投资建议/);
});

test('P2 匿名与缺省值不抛错', () => {
  const card = buildShareCard({});
  assert.equal(card.displayName, '匿名交易者');
  assert.equal(card.outcome, '与大盘持平');
  assert.equal(card.radar, null);
});

/* ---------------- RQ-20 房间赛 ---------------- */
test('P1 三种周期可解析，非法值回退 1d', () => {
  assert.equal(resolveDuration('1d'), '1d');
  assert.equal(resolveDuration('3d'), '3d');
  assert.equal(resolveDuration('1w'), '1w');
  assert.equal(resolveDuration('999d'), '1d');
  assert.equal(resolveDuration(undefined), '1d');
  assert.deepEqual(Object.keys(DURATION_OPTIONS), ['1d', '3d', '1w']);
});

/* ---------------- RQ-35 埋点 ---------------- */
test('P1 四类关键行为事件均已定义', () => {
  for (const e of ['replay_start', 'replay_finish', 'review_view', 'room_join', 'guide_complete']) {
    assert.equal(isValidEvent(e), true, `${e} 未定义`);
  }
  assert.equal(isValidEvent('unknown_event'), false);
  assert.ok(EVENTS.length >= 10);
});
