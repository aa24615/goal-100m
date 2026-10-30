/**
 * 区间化结论（RQ-152 / RQ-153 / I-23）
 *
 * 竞品调研（v12 §3.2）给出的路线级结论：
 *   - 「样本量门槛」已经被公共知识覆盖（journalplus <30 笔标红、fortraders <50 笔 = 假设不是结果），
 *     **不再是空位**；
 *   - 但「**给区间**」没人做：xtradingtime 只给了公式 `t = E√n/σ > 1.96`，
 *     市面上没有产品把它变成界面。
 *
 * 因此本模块把「结论」全部改成「区间 + 达标线 + 还差多少笔」：
 *   - 样本 ≥50 笔：给点估计 + 95% 置信区间 + t 值 + 是否过线；
 *   - 样本 <50 笔：**禁止点估计**（不是「标红」，而是根本不给那个数字），
 *     改说「还差 N 笔」，并切到「能说的三件事」（成本事实 / 行为事实 / 对照事实）。
 *
 * 硬约束：
 *   - **样本不足时 point 必须为 null**。给一个「标红的胜率 60%」等于什么都没挡住——
 *     用户只会记住那个 60%。这是 F-19（伪结论）的复发路径。
 *   - 达标线是常量且**与文案同源**：t>1.96 / 执行率 ≥80% / 盈亏平衡胜率 +5pp，
 *     三处（体检单、成绩卡、区间卡）共用，不允许各写一份。
 */

import { SAMPLE_THRESHOLD } from './checkupService.js';
import { buildSmallSampleFacts } from './smallSampleService.js';

/** 达标线：三条，逐条对应 v12 §7 RQ-152 验收标准 */
export const THRESHOLDS = {
  /** t 值：xtradingtime 六硬指标之一，>1.96 视为「期望值显著不为 0」 */
  tValue: { key: 'tValue', value: 1.96, op: '>', label: 't 值 > 1.96', why: 't 值未过 1.96 时，期望值与 0 的差异无法区分于噪声。' },
  /** 纪律执行率：行为计数，不需要样本，但达标线必须明示 */
  disciplineRate: { key: 'disciplineRate', value: 0.8, op: '>=', label: '纪律执行率 ≥ 80%', why: '写了计划却没执行的比例超过 20%，说明问题在纪律不在判断。' },
  /** 盈亏平衡胜率：实际胜率需高出平衡胜率 5 个百分点才谈得上正期望 */
  breakevenMargin: { key: 'breakevenMargin', value: 0.05, op: '>=', label: '实际胜率 ≥ 盈亏平衡胜率 + 5pp', why: '刚好过平衡线只够不亏，5pp 缓冲才覆盖费用与滑点的漂移。' },
};

/** 结论所需最小样本（与 RQ-77 的 SAMPLE_THRESHOLD 同源，不另设一套） */
export const MIN_SAMPLE = SAMPLE_THRESHOLD;

/** 95% 置信：Z=1.96（与 checkupService.BAND_Z 同口径） */
export const Z_95 = 1.96;

function numOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null;
}

/**
 * t 统计量（纯函数）：t = E·√n / σ
 *
 * σ ≤ 0 或 n ≤ 0 时返回 null —— 除零出来的 Infinity 一旦进了页面，
 * 用户会把它当成一个「特别好」的 t 值。
 */
export function tStat({ mean, sigma, n }) {
  const e = numOrNull(mean);
  const sd = numOrNull(sigma);
  const N = numOrNull(n);
  if (e == null || sd == null || N == null) return null;
  if (sd <= 0 || N <= 0) return null;
  return round((e * Math.sqrt(N)) / sd, 4);
}

/** 95% 置信区间（纯函数） */
export function confidenceInterval({ mean, sigma, n, z = Z_95 }) {
  const e = numOrNull(mean);
  const sd = numOrNull(sigma);
  const N = numOrNull(n);
  const zz = Number.isFinite(Number(z)) ? Number(z) : Z_95;
  if (e == null || sd == null || N == null || N <= 0) {
    return { low: null, high: null, half: null, z: zz, n: N == null ? null : N };
  }
  const half = (zz * sd) / Math.sqrt(N);
  return { low: round(e - half, 4), high: round(e + half, 4), half: round(half, 4), z: zz, n: N };
}

/**
 * 盈亏平衡胜率（纯函数）：p* = 平均亏损 / (平均盈利 + 平均亏损)
 * 两个均值都缺失时返回 null（不猜一个 50% 出来）。
 */
export function breakevenWinRate({ avgWin, avgLoss }) {
  const w = numOrNull(avgWin);
  const l = numOrNull(avgLoss);
  if (w == null || l == null) return null;
  const loss = Math.abs(l);
  const denom = Math.abs(w) + loss;
  if (denom <= 0) return null;
  return round(loss / denom, 4);
}

/** 达标判定：op 只支持 > 与 >=，避免把字符串比较混进来 */
function passOf(value, threshold) {
  const v = numOrNull(value);
  const th = threshold && typeof threshold === 'object' ? threshold : {};
  const t = numOrNull(th.value);
  if (v == null || t == null) return null;
  return th.op === '>' ? v > t : v >= t;
}

/**
 * 单个结论性指标（纯函数）。
 * 样本不足时 **point 一律为 null** —— 这是 RQ-152 的硬验收点。
 */
function buildMetric({ key, label, unit, kind, point, sigma, n, threshold, thresholdOn, extra = {} }) {
  const N = Math.max(0, Math.floor(numOrNull(n) ?? 0));
  const insufficient = N < MIN_SAMPLE;
  const remaining = Math.max(0, MIN_SAMPLE - N);
  const t = kind === 'inference' ? tStat({ mean: point, sigma, n: N }) : null;
  const ci = kind === 'inference' ? confidenceInterval({ mean: point, sigma, n: N }) : null;
  /**
   * 达标线作用在**哪个量**上必须显式声明。
   * 期望值的达标线是「t 值 > 1.96」，而它的 point 是 R 倍数（通常在 ±1 之间）——
   * 若拿 point 去比 1.96，会永远判「未过线」，等于把达标线做成了摆设。
   */
  const cmp = thresholdOn === 't' ? t : point;
  const pass = threshold && !insufficient ? passOf(cmp, threshold) : null;

  if (insufficient) {
    return {
      key,
      label,
      unit: unit || null,
      kind,
      sampleSize: N,
      /** 硬约束：样本不足不给点估计 */
      point: null,
      interval: null,
      t: null,
      threshold: threshold
        ? { label: threshold.label, value: threshold.value, op: threshold.op, why: threshold.why }
        : null,
      pass: null,
      conclusive: false,
      remaining,
      verdict: {
        level: 'insufficient',
        text: `样本 ${N} 笔，还差 ${remaining} 笔才能下结论（门槛 ${MIN_SAMPLE} 笔）。`,
        canSay: '现在能确认的只有成本、行为与对照三类事实。',
      },
      ...extra,
    };
  }

  const text =
    ci && ci.low != null
      ? `${label} ${round(point, 4)}${unit || ''}（95% 区间 ${round(ci.low, 4)} ~ ${round(ci.high, 4)}${unit || ''}` +
        (t != null ? `，t=${round(t, 2)}` : '') +
        `，n=${N}）`
      : `${label} ${round(point, 4)}${unit || ''}（n=${N}）`;

  return {
    key,
    label,
    unit: unit || null,
    kind,
    sampleSize: N,
    point: round(point, 4),
    interval: ci && ci.low != null ? ci : null,
    t: t == null ? null : round(t, 2),
    threshold: threshold
      ? { label: threshold.label, value: threshold.value, op: threshold.op, why: threshold.why }
      : null,
    pass,
    conclusive: true,
    remaining: 0,
    verdict: {
      level: pass === null ? 'no-threshold' : pass ? 'pass' : 'fail',
      text: pass === null ? text : `${text} · 达标线 ${threshold.label}：${pass ? '通过' : '未通过'}`,
      canSay: pass === false && threshold ? threshold.why : null,
    },
    ...extra,
  };
}

/**
 * 构建区间化结论面板（纯函数）。
 *
 * @param {object} o
 * @param {number} [o.sampleSize]      已平仓笔数
 * @param {number} [o.expectancyR]     期望值（R）
 * @param {number} [o.sigma]           R 的标准差
 * @param {number} [o.winRate]         胜率（0~1）
 * @param {number} [o.avgWin]          平均盈利（R）
 * @param {number} [o.avgLoss]         平均亏损（R，取绝对值参与计算）
 * @param {number} [o.disciplineRate]  纪律执行率（0~1）
 * @param {object} [o.smallSample]     透传给 smallSampleService 的成本/行为/对照数据
 */
export function buildIntervalConclusion(o) {
  const src = o && typeof o === 'object' ? o : {};
  const n = Math.max(0, Math.floor(numOrNull(src.sampleSize) ?? 0));
  const insufficient = n < MIN_SAMPLE;

  const metrics = [
    buildMetric({
      key: 'expectancy',
      label: '期望值',
      unit: 'R',
      kind: 'inference',
      point: src.expectancyR,
      sigma: src.sigma,
      n,
      // 达标线作用在 t 值上，而不是期望值本身
      threshold: THRESHOLDS.tValue ? { ...THRESHOLDS.tValue, label: `t 值 > ${THRESHOLDS.tValue.value}` } : null,
      thresholdOn: 't',
    }),
    buildMetric({
      key: 'winRate',
      label: '胜率',
      unit: '%',
      kind: 'inference',
      // 胜率的 σ 由 p(1-p) 推导，避免调用方必须自己算标准差
      point: src.winRate == null ? null : numOrNull(src.winRate),
      sigma: numOrNull(src.winRate) == null ? null : Math.sqrt(Math.max(0, numOrNull(src.winRate)) * (1 - Math.min(1, Math.max(0, numOrNull(src.winRate))))),
      n,
      // 胜率的达标线是「相对盈亏平衡胜率 +5pp」，不是固定值，交给下面 breakeven 块判定，
      // 这里不设 threshold，避免出现「0.6 ≥ 0.05 就算过线」这种无意义的比较
      threshold: null,
    }),
    buildMetric({
      key: 'disciplineRate',
      label: '纪律执行率',
      unit: '%',
      kind: 'count',
      point: src.disciplineRate,
      sigma: null,
      n,
      threshold: THRESHOLDS.disciplineRate,
    }),
  ];

  const be = breakevenWinRate({ avgWin: src.avgWin, avgLoss: src.avgLoss });
  const winRate = numOrNull(src.winRate);
  const bePass = be != null && winRate != null ? winRate >= be + THRESHOLDS.breakevenMargin.value : null;

  const anyPointEstimate = metrics.some((m) => m.point != null && !m.conclusive);

  return {
    sampleSize: n,
    threshold: MIN_SAMPLE,
    insufficient,
    metrics,
    breakeven: {
      winRate: be,
      actual: winRate,
      margin: be != null && winRate != null ? round(winRate - be, 4) : null,
      required: THRESHOLDS.breakevenMargin.value,
      pass: bePass,
      label: THRESHOLDS.breakevenMargin.label,
      available: !insufficient && be != null && winRate != null,
    },
    thresholds: THRESHOLDS,
    /**
     * 自测守卫：样本不足时**不得**出现任何点估计。
     * 断言写在这里而不是散在测试里，是为了让页面自己也能调用它做兜底。
     */
    guard: {
      noPointEstimateWhenSmall: !anyPointEstimate,
      ok: insufficient ? !anyPointEstimate : true,
      note: `样本 < ${MIN_SAMPLE} 笔时，所有结论性指标必须只给「还差 N 笔」，不得给点估计。`,
    },
    verdict: insufficient
      ? {
          level: 'insufficient',
          text: `样本 ${n} 笔，未达 ${MIN_SAMPLE} 笔门槛：这里不给任何点估计结论，只给「还差 ${Math.max(0, MIN_SAMPLE - n)} 笔」。`,
          conclusive: false,
        }
      : {
          level: 'conclusive',
          text: `样本 ${n} 笔已达 ${MIN_SAMPLE} 笔：所有结论均带 95% 区间与达标线，未过线的会明确写出未过线。`,
          conclusive: true,
        },
    method:
      `t = E·√n/σ，95% 区间 = E ± 1.96σ/√n；达标线：t>${THRESHOLDS.tValue.value}、` +
      `${THRESHOLDS.disciplineRate.label}、${THRESHOLDS.breakevenMargin.label}。`,
    disclaimer: '区间描述的是「这一批样本能确定到什么程度」，不是对未来的承诺。',
  };
}

/**
 * 结论面板（RQ-152 + RQ-153 合流）。
 *
 * 样本 < 50 笔：返回「能说的三件事」（成本 / 行为 / 对照），**不返回点估计**；
 * 样本 ≥ 50 笔：返回区间化结论。
 * 页面只需要判断 `mode`，不再自己写 if —— 「页面太空就塞点数字进去」是 F-32 同类错误的复发路径。
 */
export function buildConclusionPanel(o) {
  const src = o && typeof o === 'object' ? o : {};
  const n = Math.max(0, Math.floor(numOrNull(src.sampleSize) ?? 0));
  const interval = buildIntervalConclusion(src);
  const facts = buildSmallSampleFacts({
    sampleSize: n,
    ...(src.smallSample && typeof src.smallSample === 'object' ? src.smallSample : {}),
  });

  const insufficient = n < MIN_SAMPLE;
  return {
    mode: insufficient ? 'three-facts' : 'interval',
    sampleSize: n,
    threshold: MIN_SAMPLE,
    remaining: Math.max(0, MIN_SAMPLE - n),
    /** 小样本时页面只渲染这个 */
    facts: insufficient ? facts : null,
    /** 样本足够时页面只渲染这个 */
    interval: insufficient ? null : interval,
    // 两种模式都要显示「还差/已达」，避免用户以为页面坏了
    headline: insufficient
      ? `样本 ${n} 笔：这里只说现在就能确定的三件事，还差 ${Math.max(0, MIN_SAMPLE - n)} 笔才能谈胜率与期望值。`
      : `样本 ${n} 笔：所有结论都带 95% 区间与达标线。`,
    guard: interval.guard,
    disclaimer: interval.disclaimer,
  };
}
