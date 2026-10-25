/**
 * RQ-76 交易体检单 / RQ-77 样本门槛 / RQ-78 拆解与提示 —— 单元测试
 *
 * 覆盖四级优先级：
 *   P0 正常流程 · P1 拆解与提示 · P3 边界条件 · P4 异常与降级 · P5 口径一致
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_THRESHOLD,
  METRIC_HINTS,
  buildCheckup,
  expectancy,
  rMultiples,
  holdTimeCompare,
  disciplineRate,
  worstHabit,
  breakdownBy,
  riskUnitOf,
} from '../../src/services/checkupService.js';

const round = (o) => ({ status: 'closed', holdDays: 5, fee: 3, ...o });

function makeRounds(n, { winPnl = 100, lossPnl = -50, winsEvery = 2, dayStep = 1 } = {}) {
  const out = [];
  const base = Date.UTC(2026, 0, 5, 2, 0, 0); // 周一 10:00 上海时间
  for (let i = 0; i < n; i += 1) {
    const isWin = i % winsEvery === 0;
    out.push(
      round({
        sellId: i + 1,
        code: `60000${i % 10}`,
        realizedPnl: isWin ? winPnl : lossPnl,
        holdDays: isWin ? 2 : 9,
        fee: 5,
        source: 'REAL',
        closedAt: new Date(base + i * dayStep * 86400000).toISOString(),
      })
    );
  }
  return out;
}

/* ------------------------- RQ-76 · P0 正常流程 ------------------------- */

test('P0 · RQ-76 期望值按 胜率×平均盈利 − 败率×平均亏损 计算', () => {
  const closed = [round({ realizedPnl: 100 }), round({ realizedPnl: -50 })];
  const e = expectancy(closed);
  assert.equal(e.winRate, 50);
  assert.equal(e.avgWin, 100);
  assert.equal(e.avgLoss, 50);
  assert.equal(e.amount, 25); // 0.5*100 - 0.5*50
  assert.equal(e.r, 0.5); // 25 / 50
});

test('P0 · RQ-76 负期望样本被识别为负（胜率高也可能亏钱）', () => {
  // 胜率 75%，但平均亏损是平均盈利的 5 倍 → 期望为负
  const closed = [
    round({ realizedPnl: 10 }),
    round({ realizedPnl: 10 }),
    round({ realizedPnl: 10 }),
    round({ realizedPnl: -50 }),
  ];
  const e = expectancy(closed);
  assert.equal(e.winRate, 75);
  assert.ok(e.amount < 0, `期望值应为负，实际 ${e.amount}`);

  // 同样的结构重复到 52 笔（跨过 50 笔门槛）后，结论必须是「没有 edge」
  const many = [];
  for (let i = 0; i < 13; i += 1) {
    many.push(
      round({ sellId: many.length + 1, realizedPnl: 10 }),
      round({ sellId: many.length + 2, realizedPnl: 10 }),
      round({ sellId: many.length + 3, realizedPnl: 10 }),
      round({ sellId: many.length + 4, realizedPnl: -50 })
    );
  }
  const c = buildCheckup({ rounds: many });
  assert.equal(c.sufficient, true);
  assert.equal(c.verdict.hasEdge, false, '胜率 75% 但盈亏比失衡时仍应判定无 edge');
  assert.ok(c.verdict.summary.includes('负期望'));
});

test('P0 · RQ-76 R 倍数以平均亏损为单位归一化', () => {
  const closed = [round({ realizedPnl: 100 }), round({ realizedPnl: -50 })];
  const e = expectancy(closed);
  const rm = rMultiples(closed, e.avgLoss);
  // 100/50 = 2R，-50/50 = -1R → 均值 0.5R
  assert.equal(rm.avgR, 0.5);
  assert.equal(rm.count, 2);
});

test('P0 · RQ-76 有自定义计划止损时优先用计划风险作分母', () => {
  const r = round({ realizedPnl: 200, plannedRisk: 100 });
  const rm = rMultiples([r], 50);
  assert.equal(rm.avgR, 2); // 200/100，而不是 200/50
  assert.equal(rm.list[0].planned, true);
  assert.equal(riskUnitOf(r, 50), 100);
});

test('P0 · RQ-76 盈利单 vs 亏损单持仓时间对比与比值', () => {
  const closed = [
    round({ realizedPnl: 100, holdDays: 2 }),
    round({ realizedPnl: -50, holdDays: 10 }),
  ];
  const h = holdTimeCompare(closed);
  assert.equal(h.winHoldDays, 2);
  assert.equal(h.lossHoldDays, 10);
  assert.equal(h.ratio, 5); // 亏损持仓是盈利的 5 倍 → 典型「截断利润让亏损奔跑」
});

test('P0 · RQ-76 纪律执行率 = 已记录 ÷ 全部决策点', () => {
  const d = [
    { reason: '放量突破', skipped: false },
    { reason: '', skipped: true },
    { reason: '破位止损', skipped: false },
    { reason: '', skipped: true },
  ];
  const r = disciplineRate(d);
  assert.equal(r.total, 4);
  assert.equal(r.recorded, 2);
  assert.equal(r.rate, 50);
});

test('P0 · RQ-76 最坏习惯取代价最高的一项（手续费侵蚀）', () => {
  const closed = [
    round({ realizedPnl: -200, fee: 300 }),
    round({ realizedPnl: 50, fee: 300 }),
  ];
  const w = worstHabit(closed);
  assert.ok(w.worst);
  assert.equal(w.worst.key, 'fee_drag');
  assert.equal(w.worst.cost, 600);
  assert.ok(w.all.length >= 2, '应同时给出候选清单以便对比');
});

test('P0 · RQ-76 单笔最大亏损成为最坏习惯时金额正确', () => {
  const closed = [round({ realizedPnl: -5000, fee: 1 }), round({ realizedPnl: 20, fee: 1 })];
  const w = worstHabit(closed);
  assert.equal(w.worst.key, 'biggest_single_loss');
  assert.equal(w.worst.cost, 5000);
});

/* ------------------------- RQ-77 · P0 样本门槛 ------------------------- */

test('P0 · RQ-77 样本 <50 笔不输出结论性判断，只给还差几笔', () => {
  const c = buildCheckup({ rounds: makeRounds(12) });
  assert.equal(c.sufficient, false);
  assert.equal(c.remaining, SAMPLE_THRESHOLD - 12);
  assert.equal(c.verdict, null, '未达门槛时 verdict 必须为 null');
  assert.ok(c.gate.message.includes('还差 38 笔'));
  assert.equal(c.rawRounds.length, 12, '样本不足时应回传原始流水供展示');
});

test('P0 · RQ-77 样本达到 50 笔当日即输出结论，且带免责声明', () => {
  const c = buildCheckup({ rounds: makeRounds(50) });
  assert.equal(c.sufficient, true);
  assert.ok(c.verdict);
  assert.equal(c.remaining, 0);
  assert.ok(c.verdict.disclaimer.includes('不构成投资建议'));
  assert.equal(c.rawRounds.length, 0, '达标后不再重复下发原始流水');
});

test('P0 · RQ-77 49 笔仍不达标，50 笔达标——边界正好在门槛上', () => {
  assert.equal(buildCheckup({ rounds: makeRounds(49) }).sufficient, false);
  assert.equal(buildCheckup({ rounds: makeRounds(50) }).sufficient, true);
});

test('P0 · RQ-77 样本不足时也不打任何「风格标签」：verdict 里没有评级字段', () => {
  const c = buildCheckup({ rounds: makeRounds(3) });
  const json = JSON.stringify(c.verdict);
  assert.equal(json, 'null');
});

/* ------------------------- RQ-78 · P1 拆解与提示 ------------------------- */

test('P1 · RQ-78 每项指标都带「说明什么 / 何时该改」口径提示', () => {
  for (const [k, v] of Object.entries(METRIC_HINTS)) {
    assert.ok(v.meaning.length > 0, `${k} 缺 meaning`);
    assert.ok(v.whenToChange.length > 0, `${k} 缺 whenToChange`);
    assert.ok(v.formula.length > 0, `${k} 缺 formula`);
  }
  const c = buildCheckup({ rounds: makeRounds(60) });
  assert.ok(c.expectancy.hint);
  assert.ok(c.expectancyR.hint);
  assert.ok(c.rMultiple.hint);
  assert.ok(c.holdTime.hint);
  assert.ok(c.discipline.hint);
});

test('P1 · RQ-78 按持仓时长拆解盈亏，可回溯到原始成交行 sellId', () => {
  const rounds = [
    round({ sellId: 1, realizedPnl: 100, holdDays: 1 }),
    round({ sellId: 2, realizedPnl: -30, holdDays: 30 }),
  ];
  const b = breakdownBy(rounds);
  assert.equal(b.byHold.length, 2);
  assert.ok(b.byHold.every((g) => g.sellIds.length === 1));
  const d1 = b.byHold.find((g) => g.key === 'd1');
  assert.equal(d1.pnl, 100);
  assert.deepEqual(d1.sellIds, [1]);
});

test('P1 · RQ-78 按交易时段拆解：早盘/午盘/盘后互不混淆', () => {
  const rounds = [
    round({ sellId: 1, realizedPnl: 10, closedAt: '2026-01-05T02:00:00Z' }), // 周一 10:00 上海
    round({ sellId: 2, realizedPnl: -5, closedAt: '2026-01-05T06:00:00Z' }), // 周一 14:00 上海
    round({ sellId: 3, realizedPnl: 7, closedAt: '2026-01-05T12:00:00Z' }), // 周一 20:00 上海
  ];
  const b = breakdownBy(rounds);
  const morning = b.bySession.find((g) => g.key === 'morning');
  const afternoon = b.bySession.find((g) => g.key === 'afternoon');
  const off = b.bySession.find((g) => g.key === 'offsession');
  assert.equal(morning.pnl, 10);
  assert.equal(afternoon.pnl, -5);
  assert.equal(off.pnl, 7);
});

test('P1 · RQ-78 按来源拆解：REAL / REPLAY / BLIND 各自独立', () => {
  const rounds = [
    round({ sellId: 1, realizedPnl: 10, source: 'REAL' }),
    round({ sellId: 2, realizedPnl: -4, source: 'BLIND' }),
  ];
  const b = breakdownBy(rounds);
  assert.equal(b.bySource.length, 2);
  assert.equal(b.bySource.find((g) => g.key === 'REAL').pnl, 10);
  assert.equal(b.bySource.find((g) => g.key === 'BLIND').pnl, -4);
});

/* ------------------------- P3 边界条件 ------------------------- */

test('P3 · RQ-77 零交易样本不输出结论且不产生 NaN', () => {
  const c = buildCheckup({ rounds: [] });
  assert.equal(c.sufficient, false);
  assert.equal(c.remaining, SAMPLE_THRESHOLD);
  assert.equal(c.expectancy.amount, 0);
  assert.equal(c.expectancy.r, null, '无亏损样本时 R 应为 null 而不是 Infinity');
  assert.equal(c.holdTime.ratio, null);
  assert.equal(c.worstHabit, null);
  assert.ok(!JSON.stringify(c).includes('null,null,null,null,null'));
});

test('P3 · RQ-76 全部盈利（无亏损）时 R 与比值返回 null 而非除零', () => {
  const closed = [round({ realizedPnl: 10 }), round({ realizedPnl: 20 })];
  const e = expectancy(closed);
  assert.equal(e.r, null);
  const h = holdTimeCompare(closed);
  assert.equal(h.ratio, null, '无亏损单时比值无定义');
  const rm = rMultiples(closed, e.avgLoss);
  assert.equal(rm.avgR, null, '无风险单位时不应产出 R');
});

test('P3 · RQ-76 无决策记录时纪律执行率为 null（不是 0）——避免给未记录者打负面标签', () => {
  const r = disciplineRate([]);
  assert.equal(r.rate, null);
  assert.equal(r.total, 0);
  const c = buildCheckup({ rounds: makeRounds(60), decisions: [] });
  assert.equal(c.discipline.rate, null);
  assert.ok(c.discipline.note.includes('尚无决策记录'));
});

test('P3 · RQ-76 决策 reason 为空白串按「未记录」计', () => {
  const r = disciplineRate([{ reason: '   ' }, { reason: 'ok' }]);
  assert.equal(r.recorded, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.rate, 50);
});

test('P3 · RQ-77 rounds 含未平仓（open）回合时不计入样本数', () => {
  const rounds = [...makeRounds(50), round({ status: 'open', realizedPnl: 0 })];
  const c = buildCheckup({ rounds });
  assert.equal(c.sampleSize, 50, '未平仓不计入已平仓笔数');
  assert.equal(c.sufficient, true);
});

test('P3 · RQ-76 金额为 0 的回合既不算盈利也不算亏损', () => {
  const e = expectancy([round({ realizedPnl: 0 }), round({ realizedPnl: 100 })]);
  assert.equal(e.winCount, 1);
  assert.equal(e.lossCount, 0);
  assert.equal(e.amount, 50);
});

/* ------------------------- P4 异常与降级 ------------------------- */

test('P4 · RQ-76 入参缺失 / 脏数据不抛异常', () => {
  for (const input of [undefined, {}, { rounds: null }, { rounds: [null, undefined] }]) {
    const c = buildCheckup(input);
    assert.equal(typeof c.sufficient, 'boolean');
    assert.equal(typeof c.sampleSize, 'number');
  }
});

test('P4 · RQ-76 realizedPnl 为字符串/NaN 时不污染统计结果', () => {
  const c = buildCheckup({ rounds: [round({ realizedPnl: 'abc' }), round({ realizedPnl: NaN }), round({ realizedPnl: 100 })] });
  assert.equal(Number.isFinite(c.expectancy.amount), true);
  assert.equal(c.expectancy.winCount, 1);
});

test('P4 · RQ-78 closedAt 非法时归入 unknown 分组而非崩溃', () => {
  const b = breakdownBy([round({ sellId: 1, realizedPnl: 5, closedAt: 'not-a-date' })]);
  assert.equal(b.bySession.length, 1);
  assert.equal(b.bySession[0].key, 'unknown');
  assert.equal(b.byWeekday[0].key, 'unknown');
});

/* ------------------------- P5 口径一致性 ------------------------- */

test('P5 · RQ-77 可信门槛常量为 50，与行业 readiness 门槛一致', () => {
  assert.equal(SAMPLE_THRESHOLD, 50);
});

test('P5 · RQ-76 体检单结论可回溯到原始成交行（ sellId 完整保留）', () => {
  const rounds = makeRounds(60);
  const c = buildCheckup({ rounds });
  const ids = new Set(c.breakdown.byHold.flatMap((g) => g.sellIds));
  assert.equal(ids.size, 60, '每笔成交都应能通过 sellId 回溯');
});

test('P5 · RQ-76 体检单与 scorecard 同源时不出现自我矛盾：期望值与胜率符号一致', () => {
  const rounds = makeRounds(60, { winPnl: 200, lossPnl: -50, winsEvery: 3 });
  const c = buildCheckup({ rounds });
  if (c.expectancy.amount > 0) assert.equal(c.verdict.hasEdge, true);
  else assert.equal(c.verdict.hasEdge, false);
});
