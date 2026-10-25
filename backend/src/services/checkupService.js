/**
 * 交易体检单（RQ-76 / RQ-77 / RQ-78）
 *
 * 定位：补齐 5 个「真正预测 edge」的决定论指标，全部是算术、不接任何 AI：
 *   1. 期望值（金额与 R）
 *   2. R 倍数
 *   3. 盈利单 vs 亏损单持仓时间对比
 *   4. 纪律执行率
 *   5. 最坏习惯的成本
 *
 * 并落实 RQ-77 样本门槛：样本 < 50 笔**不输出任何结论性判断**（不评级、不打标签），
 * 只给「还差 N 笔」与原始流水。理由：3 笔交易就给出「你的胜率 67%」不是反馈，是幻觉；
 * 行业公认的可信门槛是 ≥50 笔（ChartingLens 2026）。
 *
 * 全部为纯函数，不依赖 DB —— 便于单测，也让「指标值可回溯到原始成交行」成为硬约束。
 */

import { round2, pct2, shToday } from '../utils/time.js';

/** RQ-77 可信评估所需的最小已平仓笔数 */
export const SAMPLE_THRESHOLD = 50;

/** 指标口径说明（RQ-78：每项附「说明什么 / 何时该改」一行提示），页面必须原样展示 */
export const METRIC_HINTS = {
  expectancy: {
    label: '期望值',
    meaning: '平均每笔交易能赚多少：胜率 × 平均盈利 − 败率 × 平均亏损。为正才说明策略长期可执行。',
    whenToChange: '连续两个周期仍为负 → 先停止加仓，回到样本最多的那个 setup 单独复核。',
    formula: 'E = W×avgWin − L×avgLoss',
  },
  expectancyR: {
    label: '期望值（R）',
    meaning: '把「你的平均亏损」记为 1R 后的每笔期望收益，可跨仓位规模比较。>0.2R 才算有明显 edge。',
    whenToChange: '低于 0.1R → 不要放大仓位，先修平均亏损或胜率其中一项。',
    formula: 'E(R) = E(金额) ÷ 平均亏损额',
  },
  rMultiple: {
    label: 'R 倍数',
    meaning: '单笔盈亏相对该笔计划风险（缺省用平均亏损作单位）的倍数，是唯一值得记录的归一化指标。',
    whenToChange: '盈利单普遍 <1R 而亏损单 >1R → 在截断利润、让亏损奔跑，先练固定比例止损。',
    formula: 'R = realizedPnl ÷ riskUnit',
  },
  holdTime: {
    label: '盈亏持仓时间对比',
    meaning: '盈利单与亏损单平均持有天数的比值。>1.5 说明「赚一点就跑、亏了死扛」。',
    whenToChange: '比值 >1.5 → 给盈利单设最短持有期，把决策从情绪移到规则上。',
    formula: 'holdRatio = 亏损平均持有天数 ÷ 盈利平均持有天数',
  },
  discipline: {
    label: '纪律执行率',
    meaning: '关键决策点中「写了理由/计划止损」的占比，是行业公认最具预测力的行为指标。',
    whenToChange: '低于 70% → 先别换策略，把「每次下单前必须写一句话」练成习惯。',
    formula: 'discipline = 已记录决策 ÷ 全部决策点',
  },
  worstHabit: {
    label: '最坏习惯的成本',
    meaning: '在手续费侵蚀、报复性交易、单笔最大亏损、最长连亏中，代价最高的那一项折成金额。',
    whenToChange: '先改这一项，比同时改五项更容易见效；改完再跑 50 笔重新体检。',
    formula: 'cost = max(各类可量化习惯的代价)',
  },
};

const HOLD_BUCKETS = [
  { key: 'd1', label: '1 日以内', test: (d) => d <= 1 },
  { key: 'd2_5', label: '2-5 日', test: (d) => d > 1 && d <= 5 },
  { key: 'd6_20', label: '6-20 日', test: (d) => d > 5 && d <= 20 },
  { key: 'd20p', label: '20 日以上', test: (d) => d > 20 },
];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 上海时区小时，用于把成交归因到早盘/午盘/盘后 */
function shHour(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 3600 * 1000).getUTCHours();
}

function sessionOf(ts) {
  const h = shHour(ts);
  if (h == null) return 'unknown';
  if (h >= 9 && h < 12) return 'morning';
  if (h >= 13 && h < 16) return 'afternoon';
  return 'offsession';
}

const SESSION_LABEL = { morning: '早盘 09-12', afternoon: '午盘 13-16', offsession: '盘后/其它', unknown: '未知' };

function bucketOf(days) {
  return HOLD_BUCKETS.find((b) => b.test(days)) || HOLD_BUCKETS[HOLD_BUCKETS.length - 1];
}

/**
 * 单笔风险单位（R）。
 * 优先取用户自己写的计划止损（RQ-38 决策记录），其次退化为「平均亏损额」——
 * 后者是行业通用的归一化单位，口径在页面明示。
 */
export function riskUnitOf(round, fallbackAvgLoss) {
  const planned = Number(round?.plannedRisk);
  if (Number.isFinite(planned) && planned > 0) return planned;
  const fb = Number(fallbackAvgLoss);
  return Number.isFinite(fb) && fb > 0 ? fb : null;
}

/** 期望值：金额与 R 双口径 */
export function expectancy(closed = []) {
  const n = closed.length;
  if (n === 0) return { amount: 0, r: null, avgWin: 0, avgLoss: 0, winRate: 0, lossRate: 0 };
  const wins = closed.filter((r) => Number(r.realizedPnl) > 0);
  const losses = closed.filter((r) => Number(r.realizedPnl) < 0);
  const grossWin = wins.reduce((s, r) => s + Number(r.realizedPnl), 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + Number(r.realizedPnl), 0));
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const winRate = wins.length / n;
  const lossRate = losses.length / n;
  const amount = winRate * avgWin - lossRate * avgLoss;
  // 无亏损样本时 R 无定义（除零），返回 null 而不是 Infinity
  const r = avgLoss > 0 ? pct2(amount / avgLoss) : null;
  return {
    amount: round2(amount),
    r,
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    winRate: pct2(winRate * 100),
    lossRate: pct2(lossRate * 100),
    winCount: wins.length,
    lossCount: losses.length,
    grossProfit: round2(grossWin),
    grossLoss: round2(grossLoss),
  };
}

/** R 倍数序列与均值 */
export function rMultiples(closed = [], fallbackAvgLoss) {
  const list = [];
  let sum = 0;
  let counted = 0;
  for (const r of closed) {
    const unit = riskUnitOf(r, fallbackAvgLoss);
    if (!unit) continue;
    const rr = pct2(Number(r.realizedPnl || 0) / unit);
    list.push({ sellId: r.sellId ?? null, code: r.code, r: rr, planned: Boolean(Number(r.plannedRisk) > 0) });
    sum += rr;
    counted += 1;
  }
  return { avgR: counted > 0 ? pct2(sum / counted) : null, count: counted, list };
}

/** 盈利单 vs 亏损单持仓时间对比（天） */
export function holdTimeCompare(closed = []) {
  const wins = closed.filter((r) => Number(r.realizedPnl) > 0);
  const losses = closed.filter((r) => Number(r.realizedPnl) < 0);
  const avg = (arr) => (arr.length > 0 ? arr.reduce((s, r) => s + Number(r.holdDays || 0), 0) / arr.length : null);
  const winHold = avg(wins);
  const lossHold = avg(losses);
  return {
    winHoldDays: winHold == null ? null : pct2(winHold),
    lossHoldDays: lossHold == null ? null : pct2(lossHold),
    // 分子为 0（盈利单全是当日了结）时比值无意义，返回 null 而不是 Infinity
    ratio: winHold != null && lossHold != null && winHold > 0 ? pct2(lossHold / winHold) : null,
    winCount: wins.length,
    lossCount: losses.length,
  };
}

/**
 * 纪律执行率。
 * 无决策记录时**返回 null 而不是 0** ——「没有数据」不等于「纪律为零」，
 * 否则还没开始记录决策的用户会被打上 0% 的负面标签，与 RQ-77 的初衷冲突。
 */
export function disciplineRate(decisions = []) {
  const total = decisions.length;
  if (total === 0) return { rate: null, total: 0, recorded: 0, skipped: 0, note: '尚无决策记录，指标未生成' };
  const recorded = decisions.filter((d) => d && d.skipped !== true && nonempty(d.reason)).length;
  const skipped = total - recorded;
  return {
    rate: pct2((recorded / total) * 100),
    total,
    recorded,
    skipped,
    note: '已写理由或计划止损的决策点 ÷ 全部决策点',
  };
}

function nonempty(v) {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

/** 最坏习惯的成本：在可量化的习惯目录中取代价最高的一项 */
export function worstHabit(closed = []) {
  const candidates = [];

  const totalFee = closed.reduce((s, r) => s + (Number(r.fee) || 0), 0);
  if (totalFee > 0) {
    candidates.push({
      key: 'fee_drag',
      label: '过度交易产生的手续费',
      cost: round2(totalFee),
      detail: `${closed.length} 笔交易累计付出 ¥${round2(totalFee)} 手续费，这部分是确定的现金流出。`,
    });
  }

  // 报复性交易：同一自然日内，上一笔刚亏完就再次开仓且又亏
  const sorted = [...closed].sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  let revengeCost = 0;
  let revengeCount = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const sameDay =
      prev.closedAt && cur.closedAt && shToday(new Date(prev.closedAt)) === shToday(new Date(cur.closedAt));
    if (sameDay && Number(prev.realizedPnl) < 0 && Number(cur.realizedPnl) < 0) {
      revengeCost += Math.abs(Number(cur.realizedPnl));
      revengeCount += 1;
    }
  }
  if (revengeCount > 0) {
    candidates.push({
      key: 'revenge_trade',
      label: '亏损后当日再次交易的额外亏损',
      cost: round2(revengeCost),
      detail: `有 ${revengeCount} 笔是在当日已亏损后继续交易并再次亏损，合计多亏 ¥${round2(revengeCost)}。`,
    });
  }

  const losses = closed.filter((r) => Number(r.realizedPnl) < 0);
  if (losses.length > 0) {
    const worst = Math.abs(Math.min(...losses.map((r) => Number(r.realizedPnl))));
    candidates.push({
      key: 'biggest_single_loss',
      label: '单笔最大亏损',
      cost: round2(worst),
      detail: `单笔最大亏损 ¥${round2(worst)}，通常对应「没设止损」或「亏损后加仓」。`,
    });
  }

  // 最长连亏：连续亏损段的累计亏损最大值
  let maxStreak = 0;
  let cur = 0;
  for (const r of sorted) {
    if (Number(r.realizedPnl) < 0) {
      cur += Math.abs(Number(r.realizedPnl));
      if (cur > maxStreak) maxStreak = cur;
    } else {
      cur = 0;
    }
  }
  if (maxStreak > 0) {
    candidates.push({
      key: 'losing_streak',
      label: '最长连亏段的累计亏损',
      cost: round2(maxStreak),
      detail: `最长一段连续亏损共吃掉 ¥${round2(maxStreak)}，连亏期间是否放大过仓位值得回看。`,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.cost - a.cost);
  return { worst: candidates[0], all: candidates };
}

/**
 * 按维度拆解盈亏（RQ-78）：默认给持仓时长、星期、交易时段、来源四个维度。
 * 每条分组都可回溯到原始成交行（返回 sellId 列表）。
 */
export function breakdownBy(closed = []) {
  const group = (fn, labels) => {
    const map = new Map();
    for (const r of closed) {
      const key = fn(r);
      const g = map.get(key) || { key, label: labels?.[key] || String(key), count: 0, pnl: 0, sellIds: [] };
      g.count += 1;
      g.pnl += Number(r.realizedPnl) || 0;
      if (r.sellId != null) g.sellIds.push(r.sellId);
      map.set(key, g);
    }
    return [...map.values()]
      .map((g) => ({ ...g, pnl: round2(g.pnl) }))
      .sort((a, b) => b.pnl - a.pnl);
  };

  const holdLabels = Object.fromEntries(HOLD_BUCKETS.map((b) => [b.key, b.label]));
  return {
    byHold: group((r) => bucketOf(Number(r.holdDays || 0)).key, holdLabels),
    byWeekday: group(
      (r) => {
        const d = new Date(r.closedAt);
        return Number.isNaN(d.getTime()) ? 'unknown' : String(d.getDay());
      },
      WEEKDAYS.reduce((acc, l, i) => ({ ...acc, [String(i)]: l }), { unknown: '未知' })
    ),
    bySession: group((r) => sessionOf(r.closedAt), SESSION_LABEL),
    bySource: group((r) => String(r.source || 'REAL'), { REAL: '实时模拟账户', REPLAY: '历史回放', BLIND: '双盲训练' }),
  };
}

/**
 * 生成体检单。
 *
 * @param {object} o
 * @param {Array}  o.rounds    pairTrades 产出的回合（含 open 状态）
 * @param {Array}  o.decisions RQ-38 决策记录 [{ reason, stopPlan, skipped }]
 * @param {number} o.initialCapital
 * @returns 样本不足时 `verdict` 为 null、`metrics` 仍给原始数值；绝不输出评级/标签
 */
export function buildCheckup({ rounds = [], decisions = [], initialCapital = 0 } = {}) {
  // 默认参数只兜 undefined，兜不住显式传入的 null —— 调用方从 DB 拿不到数据时很容易传 null，
  // 体检单是只读展示，不该因为入参为空把整个复盘页打成 500。
  const list = Array.isArray(rounds) ? rounds : [];
  const closed = list.filter((r) => r && r.status !== 'open');
  const sampleSize = closed.length;
  const sufficient = sampleSize >= SAMPLE_THRESHOLD;
  const remaining = Math.max(0, SAMPLE_THRESHOLD - sampleSize);

  const exp = expectancy(closed);
  const rm = rMultiples(closed, exp.avgLoss);
  const hold = holdTimeCompare(closed);
  const disc = disciplineRate(Array.isArray(decisions) ? decisions : []);
  const habit = worstHabit(closed);

  const metrics = {
    sampleSize,
    threshold: SAMPLE_THRESHOLD,
    sufficient,
    remaining,
    expectancy: { ...exp, hint: METRIC_HINTS.expectancy },
    expectancyR: { value: exp.r, hint: METRIC_HINTS.expectancyR },
    rMultiple: { avgR: rm.avgR, count: rm.count, list: rm.list.slice(0, 50), hint: METRIC_HINTS.rMultiple },
    holdTime: { ...hold, hint: METRIC_HINTS.holdTime },
    discipline: { ...disc, hint: METRIC_HINTS.discipline },
    worstHabit: habit ? { ...habit.worst, alternatives: habit.all, hint: METRIC_HINTS.worstHabit } : null,
  };

  // RQ-77 硬约束：样本不足 → verdict 恒为 null，页面据此不渲染任何评级/标签
  const verdict = sufficient
    ? {
        // 只给方向性描述，不给「你的风格是 XX」这类人物标签
        hasEdge: exp.amount > 0,
        grade: exp.amount > 0 && (exp.r == null || exp.r > 0) ? 'positive' : 'negative',
        summary:
          exp.amount > 0
            ? `${sampleSize} 笔样本下每笔期望 ¥${exp.amount}${exp.r != null ? `（${exp.r}R）` : ''}，策略具备可执行前提。`
            : `${sampleSize} 笔样本下每笔期望 ¥${exp.amount}${exp.r != null ? `（${exp.r}R）` : ''}，当前为负期望，先修策略再谈仓位。`,
        disclaimer: '以上结论基于模拟交易行为统计，不构成投资建议，不承诺任何收益。',
      }
    : null;

  return {
    ...metrics,
    verdict,
    gate: {
      sufficient,
      sampleSize,
      threshold: SAMPLE_THRESHOLD,
      remaining,
      message: sufficient
        ? `已达到 ${SAMPLE_THRESHOLD} 笔可信样本门槛，以下结论可采信。`
        : `已记录 ${sampleSize} 笔，还差 ${remaining} 笔可生成可信评估。样本不足时不输出结论，是为了不给你不可信的判断。`,
    },
    // 样本不足时前端展示原始流水而非结论
    rawRounds: sufficient ? [] : closed.slice(0, 100),
    breakdown: sufficient ? breakdownBy(closed) : breakdownBy(closed),
  };
}

export { HOLD_BUCKETS, WEEKDAYS, SESSION_LABEL, sessionOf, bucketOf };
