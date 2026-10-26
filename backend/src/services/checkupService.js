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

/** RQ-77 可信评估所需的最小已平仓笔数（第一档门槛，保留以兼容既有调用方） */
export const SAMPLE_THRESHOLD = 50;

/* ------------------------------------------------------------------ *
 * RQ-79 可信度分档：50 行为级 / 100 绩效级 / 200 策略级               *
 * ------------------------------------------------------------------ *
 * 为什么要分档：行业通行口径本就是分档的（30 初步 / 100 可信 / 200+ 显著；
 * Edgewonk 官方为 5-10 看行为、20-30 看倾向、50-100 看绩效、100+ 才支持策略结论）。
 * 定死单一 50 一档会让「60 笔」和「500 笔」拿到同样强度的结论，
 * 属于把统计精度不足包装成确定答案——正好违背 RQ-77 的初衷。
 *
 * 每档必须同时给出「能信什么」与「还不能拿它做什么」，
 * 后者是分档的真正价值：把「数据少」从劣势转成信任资产。
 */
export const SAMPLE_TIERS = [
  {
    key: 'none',
    threshold: 0,
    label: '尚无样本',
    short: '无样本',
    canTrust: [],
    cannotTrust: ['任何胜率、期望值、R 倍数相关的结论'],
    summary: '还没有完整的买卖回合，先去练几段再来看结论。',
  },
  {
    key: 'behavior',
    threshold: 50,
    label: '行为级',
    short: '行为级',
    canTrust: [
      '有没有写交易理由与计划止损（纪律执行率）',
      '有没有出现「亏损后当日再次交易」这类可观察行为',
    ],
    cannotTrust: ['策略层面的期望值与 R 倍数结论', '按持仓时长 / 时段 / 星期的盈亏拆解归因'],
    summary: '样本够看行为，还不够看绩效。这一档只回答「你怎么做的」，不回答「你的策略行不行」。',
  },
  {
    key: 'performance',
    threshold: 100,
    label: '绩效级',
    short: '绩效级',
    canTrust: ['期望值（金额）与平均 R 倍数的方向（正 / 负）', '盈利单与亏损单的持仓时间对比'],
    cannotTrust: ['按维度拆解的归因结论', '据此放大或缩小仓位规模'],
    summary: '样本够看绩效的方向，还不够做归因。可以看期望值的正负，先别据此改仓位。',
  },
  {
    key: 'strategy',
    threshold: 200,
    label: '策略级',
    short: '策略级',
    canTrust: ['期望值与 R 倍数的量级', '按持仓时长 / 时段 / 星期的拆解归因'],
    cannotTrust: ['跨市场、跨品种的外推', '任何形式的收益承诺'],
    summary: '样本够做策略级归因。拆解维度可以用来决定「改哪一项」，但仍然不构成投资建议。',
  },
];

/** 最高档（达到后不再有下一档） */
export const TOP_TIER = SAMPLE_TIERS[SAMPLE_TIERS.length - 1];

/* ------------------------------------------------------------------ *
 * RQ-97 可信度误差带（I-1：本次检索中唯一确认的全行业空白）           *
 * ------------------------------------------------------------------ *
 * 竞品一律给满屏确定数字：60 笔就告诉你「期望值 0.31R」，
 * 却不告诉你这个数在 95% 置信度下可能是 ±0.29R——**连正负号都换得掉**。
 *
 * 口径（有公开依据，非自创）：
 *   期望值 95% 置信半宽 = Z × σ / √n，Z = 1.96（95% 双侧）
 *   行业常例：30 笔 ≈ ±0.54R、100 笔 ≈ ±0.29R（对应 σ ≈ 1.5R）
 * 因此默认 σ 取 1.5R；当用户已有自己的 R 序列时，改用**实测标准差**，
 * 让误差带随用户真实波动收敛而不是永远挂一个常数。
 */
export const BAND_Z = 1.96;
/** 无用户实测 R 序列时的默认标准差（R 倍数口径） */
export const DEFAULT_SIGMA_R = 1.5;

/** 样本标准差（n-1）。样本 < 2 时无定义，返回 null 而不是 0 */
export function stdDev(values = []) {
  const arr = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (arr.length < 2) return null;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * 期望值误差带（纯函数，可单测）。
 *
 * @param {object} o
 * @param {number} o.sampleSize 已平仓笔数 n
 * @param {number} [o.sigma]    R 倍数标准差；缺省用 DEFAULT_SIGMA_R
 * @param {number|null} [o.expectancyR] 实测期望值（R），用于判断正负号是否确定
 * @returns {object} { n, sigma, z, bandR, low, high, signUncertain, text, cannot }
 */
export function errorBandOf(o) {
  const { sampleSize, sigma, expectancyR } = o && typeof o === 'object' ? o : {};
  const n = Number.isFinite(Number(sampleSize)) ? Math.max(0, Math.floor(Number(sampleSize))) : 0;
  const sd =
    Number.isFinite(Number(sigma)) && Number(sigma) > 0 ? Number(sigma) : DEFAULT_SIGMA_R;
  const z = BAND_Z;

  // n = 0 时误差带无定义（除零）。返回 null 数值但保留可读文案，
  // 避免页面渲染出 Infinity 或 NaN。
  if (n < 1) {
    return {
      n: 0,
      sigma: round2(sd),
      z,
      bandR: null,
      low: null,
      high: null,
      signUncertain: true,
      text: '还没有样本，无法估计误差。',
      cannot: '不能据此判断任何策略的期望值方向。',
    };
  }

  const raw = (z * sd) / Math.sqrt(n);
  const bandR = pct2(raw);
  const r = Number.isFinite(Number(expectancyR)) ? Number(expectancyR) : null;
  // 误差半宽 ≥ |期望值| → 置信区间跨过 0，正负号都拿不准
  const signUncertain = r == null ? true : raw >= Math.abs(r);

  return {
    n,
    sigma: round2(sd),
    z,
    bandR,
    low: r == null ? null : pct2(r - raw),
    high: r == null ? null : pct2(r + raw),
    signUncertain,
    text:
      `${n} 笔样本的期望值误差约 ±${bandR}R（95% 置信，Z=1.96，σ=${round2(sd)}R）。` +
      (signUncertain ? '误差带跨过 0，**连正负号都不能确定**——只能看方向，不能看大小。' : '误差带未跨过 0，方向可采信，量级仍需谨慎。'),
    cannot: signUncertain
      ? '不能拿它判断策略是否赚钱，也不能据此调整仓位。'
      : '不能拿它做跨市场、跨品种的外推。',
  };
}

/* ------------------------------------------------------------------ *
 * RQ-95 小样本护栏：N < 30 不展示任何比率类结论                       *
 * ------------------------------------------------------------------ *
 * 与 RQ-77/RQ-79 的分工：
 *   - RQ-77/79 管「能不能下**结论**」（verdict / 档位）；
 *   - RQ-95 管「能不能展示**比率**」（胜率、期望值 R、平均 R、持仓比）。
 * 两者门槛不同是刻意的：N=2 时「胜率 50%」这种比率读起来像结论，
 * 但统计上纯属噪声——这正是 F-19 要消除的伪结论。
 *
 * 纪律执行率**不在此列**：它统计的是「决策点里写了几句」，是行为计数而非绩效比率，
 * 且 RQ-85 冷启动明确要求 0 笔用户先看到这一项。把它一并藏起来会让首训无从下手。
 */
export const RATIO_GUARD_THRESHOLD = 30;

/**
 * 小样本护栏（纯函数）。
 * @param {number} n 已平仓笔数
 */
export function resolveRatioGate(n) {
  const size = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
  const show = size >= RATIO_GUARD_THRESHOLD;
  const strategyTier = SAMPLE_TIERS.find((t) => t.key === 'strategy') || TOP_TIER;
  return {
    threshold: RATIO_GUARD_THRESHOLD,
    sampleSize: size,
    // 绩效类比率（胜率 / 期望值 R / 平均 R / 持仓天数比）
    showRatios: show,
    // 排名：N 太小时任何排名都是噪声排序
    showRanking: show,
    // 策略级措辞沿用 200 笔档，比 30 笔严格得多
    showStrategyLanguage: size >= strategyTier.threshold,
    remaining: Math.max(0, RATIO_GUARD_THRESHOLD - size),
    action: show ? null : { label: '继续积累样本', path: '/blind' },
    reason: show
      ? `样本 ${size} 笔已达 ${RATIO_GUARD_THRESHOLD} 笔护栏，比率类指标可读。`
      : `样本仅 ${size} 笔，未达 ${RATIO_GUARD_THRESHOLD} 笔护栏：胜率、期望值（R）、平均 R 与排名在统计上是噪声，暂不展示。`,
  };
}

/**
 * 按已平仓笔数解析可信度档位与「距下一档还差几笔」（RQ-79 + RQ-80）。
 *
 * 纯函数：n 为 null / NaN / 负数时一律按 0 处理，
 * 绝不因为脏数据把复盘页打成 500 或渲染出 NaN。
 *
 * @param {number} n 已平仓笔数
 * @returns {object} { tier, next, reachedTop, remaining, progressPercent, ... }
 */
export function resolveTier(n) {
  const size = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
  let tier = SAMPLE_TIERS[0];
  for (const t of SAMPLE_TIERS) {
    if (size >= t.threshold) tier = t;
  }
  const idx = SAMPLE_TIERS.indexOf(tier);
  const next = idx >= 0 && idx < SAMPLE_TIERS.length - 1 ? SAMPLE_TIERS[idx + 1] : null;

  // 区间进度：在「当前档门槛 → 下一档门槛」之间线性推进，
  // 比「绝对笔数 ÷ 200」更能反映「我还差多少就能升档」。
  const lo = tier.threshold;
  const hi = next ? next.threshold : tier.threshold;
  const span = hi - lo;
  const progressPercent = !next ? 100 : span > 0 ? Math.min(100, Math.round(((size - lo) / span) * 100)) : 100;

  return {
    key: tier.key,
    label: tier.label,
    short: tier.short,
    threshold: tier.threshold,
    canTrust: tier.canTrust,
    cannotTrust: tier.cannotTrust,
    summary: tier.summary,
    reachedTop: !next,
    next: next ? { key: next.key, label: next.label, short: next.short, threshold: next.threshold } : null,
    // RQ-80 距下一档还差 N 笔；已到顶档为 0
    remaining: next ? Math.max(0, next.threshold - size) : 0,
    progressPercent,
    // 兼容 RQ-77 的旧字段语义：是否跨过第一档门槛
    sufficient: size >= SAMPLE_THRESHOLD,
    // RQ-97 误差带：按当前样本量给出 ±1.96σ/√n（后续由 buildCheckup 用实测 σ 覆盖）
    band: errorBandOf({ sampleSize: size }),
  };
}

/**
 * RQ-85 冷启动：0 笔用户不该看到空面板。
 * 给出「先做 3 段盲测」的具体动作，而不是一句「还差 50 笔」把人劝退。
 */
export const COLD_START = {
  isCold: true,
  title: '先做 3 段盲测，体检单就有东西可看了',
  steps: [
    '进入双盲训练，随机抽一段真实历史行情（看不到代码、名称与日期）',
    '每到决策点写一句话：为什么买 / 卖 / 观望，计划止损在哪',
    '做完 3 段，回来看体检单的前两项指标（纪律执行率与最坏习惯）',
  ],
  sessionsTarget: 3,
  action: { label: '去做第一段盲测', path: '/blind' },
  note: '体检单不会因为你只有 3 笔就给你结论——它先帮你看清「你是怎么做的」。',
};

/**
 * RQ-83 训练处方：把「最坏习惯」翻译成定向训练计划。
 * 这是竞品全无的闭环——有体检的无训练（Edgewonk / TraderVue），有训练的无体检（绕云 / 爆竹）。
 *
 * 映射口径与 RQ-82 的片段标签保持一致，且强制记录项与纪律执行率口径同源
 * （写了理由或计划止损才计为「已执行」，见 disciplineRate）。
 */
export const PRESCRIPTION_MAP = {
  fee_drag: {
    tag: 'range',
    tagLabel: '震荡',
    title: '过度交易 · 手续费侵蚀',
    why: '震荡行情里最容易反复进出，正好练「看不懂就不动」。',
    requiredFields: ['reason', 'stopPlan'],
    drill: '每段只在决策点操作，其余时间强制观望；段末统计交易笔数是否下降。',
  },
  revenge_trade: {
    tag: 'volatile',
    tagLabel: '高波动',
    title: '亏损后当日再次交易',
    why: '高波动片段会放大情绪，专门练「亏完先停手」。',
    requiredFields: ['reason', 'stopPlan'],
    drill: '出现一笔亏损后，本段内禁止再开新仓；必须写清下次进场的触发条件。',
  },
  biggest_single_loss: {
    tag: 'pullback',
    tagLabel: '回撤',
    title: '单笔最大亏损',
    why: '回撤段专练「计划止损先写后做」，避免亏损后加仓。',
    requiredFields: ['stopPlan'],
    drill: '开仓前必须填写计划止损价，未填写则本次决策记为未执行。',
  },
  losing_streak: {
    tag: 'volatile',
    tagLabel: '高波动',
    title: '最长连亏段',
    why: '连亏通常伴随仓位放大，高波动片段最容易暴露这个问题。',
    requiredFields: ['reason', 'stopPlan'],
    drill: '连亏期间仓位不得超过首笔；每段结束回看连亏是否被截断。',
  },
};

/** 无最坏习惯（样本不足 / 全是盈利单）时的默认处方 */
export const DEFAULT_PRESCRIPTION = {
  tag: 'trend',
  tagLabel: '趋势',
  title: '先建立基线',
  why: '还没有明确的最坏习惯，先用趋势段建立行为基线。',
  requiredFields: ['reason'],
  drill: '每个决策点写一句理由，先把「记录」这个动作练成习惯。',
};

/**
 * 由体检单生成训练处方（纯函数）。
 * @param {object} checkup buildCheckup 的返回值
 */
export function buildPrescription(checkup) {
  const c = checkup && typeof checkup === 'object' ? checkup : {};
  const habitKey = c.worstHabit?.key || null;
  const base = (habitKey && PRESCRIPTION_MAP[habitKey]) || DEFAULT_PRESCRIPTION;
  const tier = resolveTier(c.sampleSize);
  return {
    habitKey,
    habitLabel: c.worstHabit?.label || null,
    habitCost: c.worstHabit?.cost ?? null,
    tag: base.tag,
    tagLabel: base.tagLabel,
    title: base.title,
    why: base.why,
    requiredFields: base.requiredFields,
    drill: base.drill,
    // 处方一次给 3 段：单段的偶然性太大，3 段才看得出行为是否重复
    sessions: 3,
    bars: 60,
    tierKey: tier.key,
    sampleSize: c.sampleSize ?? 0,
    note: '处方依据本次体检的决定论指标生成，不接任何 AI，结论可回溯到原始成交行。',
  };
}

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
export function buildCheckup(o) {
  // 默认参数只兜 undefined，兜不住**整个入参为 null** —— 调用方从 DB 拿不到数据时很容易传 null，
  // 体检单是只读展示，不该因为入参为空把整个复盘页打成 500。
  // 因此这里不用解构默认值，改为显式判空后再取字段。
  const { rounds = [], decisions = [], initialCapital = 0 } = o && typeof o === 'object' ? o : {};
  const list = Array.isArray(rounds) ? rounds : [];
  const closed = list.filter((r) => r && r.status !== 'open');
  const sampleSize = closed.length;
  const sufficient = sampleSize >= SAMPLE_THRESHOLD;
  const remaining = Math.max(0, SAMPLE_THRESHOLD - sampleSize);
  // RQ-79 / RQ-80：分档可信度 + 距下一档进度
  const tier = resolveTier(sampleSize);

  const exp = expectancy(closed);
  const rm = rMultiples(closed, exp.avgLoss);
  const hold = holdTimeCompare(closed);
  const disc = disciplineRate(Array.isArray(decisions) ? decisions : []);
  const habit = worstHabit(closed);

  // RQ-97 误差带：有实测 R 序列时用实测标准差，否则退回默认 σ（口径在 errorBandOf 内注明）
  const measuredSigma = stdDev((rm.list || []).map((x) => x.r));
  const band = errorBandOf({ sampleSize, sigma: measuredSigma, expectancyR: exp.r });
  // RQ-95 小样本护栏：N < 30 一律不给比率
  const ratioGate = resolveRatioGate(sampleSize);
  const ratios = ratioGate.showRatios
    ? {
        winRate: exp.winRate,
        expectancyR: exp.r,
        avgR: rm.avgR,
        holdRatio: hold.ratio,
        // 比率的读数口径必须和误差带一起给，否则又变成「满屏确定数字」
        bandR: band.bandR,
        signUncertain: band.signUncertain,
      }
    : null;

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
    // ---- RQ-79 可信度分档 ----
    tier,
    tierLabel: tier.label,
    canTrust: tier.canTrust,
    cannotTrust: tier.cannotTrust,
    // ---- RQ-97 误差带 ----
    errorBand: band,
    // ---- RQ-95 小样本护栏 ----
    ratioGate,
    ratios,
    // ---- RQ-80 距下一档进度 + 达标提示 ----
    progress: {
      sampleSize,
      tierKey: tier.key,
      tierLabel: tier.label,
      nextTierKey: tier.next?.key ?? null,
      nextTierLabel: tier.next?.label ?? null,
      nextThreshold: tier.next?.threshold ?? null,
      remaining: tier.remaining,
      percent: tier.progressPercent,
      reachedTop: tier.reachedTop,
      text: tier.reachedTop
        ? `已达最高档（${tier.label}），无需再凑样本。`
        : `还差 ${tier.remaining} 笔升到「${tier.next.label}」档`,
    },
    /**
     * RQ-80 「达标当日提示」：只在笔数**刚好**落在档位门槛上时为 true，
     * 前端据此弹一次且可关闭（关闭状态存本地，不污染服务端数据）。
     * 用「刚好等于门槛」而不是「≥ 门槛」，避免每次刷新都弹。
     */
    milestone: SAMPLE_TIERS.some((t) => t.threshold > 0 && sampleSize === t.threshold)
      ? {
          justReached: true,
          tierKey: tier.key,
          tierLabel: tier.label,
          message: `已达成 ${sampleSize} 笔，可信度升到「${tier.label}」档。现在可以多信一件事：${tier.canTrust[0] || '—'}`,
          cannot: `仍然不能拿它做：${tier.cannotTrust[0] || '—'}`,
          dismissible: true,
        }
      : { justReached: false },
    // ---- RQ-85 冷启动：0 笔不给空面板 ----
    coldStart: sampleSize === 0 ? { ...COLD_START } : { isCold: false },
    gate: {
      sufficient,
      sampleSize,
      threshold: SAMPLE_THRESHOLD,
      remaining,
      // 门槛文案升档后仍保留「还差 N 笔」，但改为指向下一档而非永远指向 50
      message: sufficient
        ? `已达到 ${SAMPLE_THRESHOLD} 笔可信样本门槛（当前「${tier.label}」档），以下结论可采信。`
        : `已记录 ${sampleSize} 笔，还差 ${remaining} 笔可生成可信评估。样本不足时不输出结论，是为了不给你不可信的判断。`,
    },
    // 样本不足时前端展示原始流水而非结论
    rawRounds: sufficient ? [] : closed.slice(0, 100),
    breakdown: sufficient ? breakdownBy(closed) : breakdownBy(closed),
  };
}

export { HOLD_BUCKETS, WEEKDAYS, SESSION_LABEL, sessionOf, bucketOf };
