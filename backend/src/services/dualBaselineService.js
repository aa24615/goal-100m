/**
 * 双基准个人能力对照（RQ-137 / I-19 / F-67）
 *
 * v11 识别出的空位：大波浪有**形态级**的 t 值与对照组，但**个人能力级**的双基准 8 家全未见。
 * 单基准（「跑赢买入持有」）回答不了这个问题：**这段时间买什么都涨。**
 * 用户拿到一个无法归因的收益数字，最容易做的事是自我欺骗。
 *
 * 因此同一局同时给两个基准：
 *   ① 买入持有：第一天买入、持有到最后（策略惰性基准，测「择时有没有负价值」）
 *   ② 随机入场：同一标的、随机换一天入场、同样持有到最后（运气基准，测「择时有没有正价值」）
 *
 * 只有当收益**同时**跑赢「什么都不做」和「闭眼随便挑一天」时，才谈得上「这一局有择时价值」。
 *
 * 设计约束（都是为了让结论可核对，而不是为了让页面更好看）：
 *   - **决定论**：随机数走 mulberry32(seed)，同一局永远得到同一个随机入场基准。
 *     用 Math.random 会让用户刷新一次结论就变一次——那不是基准，是噪声。
 *   - **结论受样本护栏约束**：`sampleSize < 50` 只给方向不给结论（硬约束 3），
 *     `< 30` 连比率类数字都不展示（RQ-95 既有护栏，不另设一套）。
 *   - **纯函数**：closes 由调用方注入，不发请求、不碰库。
 */

import { SAMPLE_THRESHOLD, RATIO_GUARD_THRESHOLD } from './checkupService.js';

/** 随机入场的抽样次数：500 次足够稳定，且纯函数下耗时可忽略（<1ms） */
export const RANDOM_SAMPLES = 500;

/** 入场后至少持有的天数：避免抽到最后一根那天（持有 0 天、收益恒为 0，会稀释基准） */
export const MIN_HOLD_DAYS = 1;

/**
 * 决定论伪随机数（mulberry32）。
 * 同一 seed 必然给出同一序列——这是「基准可复核」的前提。
 */
export function mulberry32(seed) {
  let a = Number(seed);
  if (!Number.isFinite(a)) a = 1;
  a = a >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function closesOf(o) {
  const raw = Array.isArray(o?.closes)
    ? o.closes
    : Array.isArray(o?.bars)
      ? o.bars.map((b) => b?.close)
      : [];
  return raw
    .map((c) => (c === null || c === undefined || String(c).trim() === '' ? NaN : Number(c)))
    .filter((c) => Number.isFinite(c) && c > 0);
}

function round(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null;
}

/** 从 fromIdx 持有到 toIdx 的收益率（%） */
export function holdReturnPct(closes, fromIdx, toIdx) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const a = Math.max(0, Math.floor(Number(fromIdx)));
  const b = Math.max(0, Math.floor(Number(toIdx)));
  if (a >= closes.length || b >= closes.length || a > b) return null;
  const base = closes[a];
  if (!Number.isFinite(base) || base <= 0) return null;
  return ((closes[b] - base) / base) * 100;
}

/**
 * 随机入场收益分布（纯函数）。
 * 每次抽一个入场日 i ∈ [0, len-1-MIN_HOLD_DAYS]，持有到最后一根。
 */
export function randomEntryDistribution(closes, opts = {}) {
  const cs = closesOf({ closes });
  const o = opts && typeof opts === 'object' ? opts : {};
  if (cs.length < 2) return { samples: [], mean: null, stdev: null, n: 0 };

  const want = Math.max(1, Math.floor(Number(o.samples) || RANDOM_SAMPLES));
  const rnd = mulberry32(o.seed ?? 1);
  const last = cs.length - 1;
  const maxEntry = last - MIN_HOLD_DAYS;
  const out = [];
  if (maxEntry < 0) return { samples: [], mean: null, stdev: null, n: 0 };

  for (let i = 0; i < want; i += 1) {
    const idx = Math.floor(rnd() * (maxEntry + 1));
    const r = holdReturnPct(cs, idx, last);
    if (r != null) out.push(r);
  }
  if (out.length === 0) return { samples: [], mean: null, stdev: null, n: 0 };

  const mean = out.reduce((s, v) => s + v, 0) / out.length;
  const variance = out.reduce((s, v) => s + (v - mean) ** 2, 0) / out.length;
  return { samples: out, mean, stdev: Math.sqrt(variance), n: out.length };
}

/** 给定收益在分布中的百分位（0~100），用于回答「闭眼买能跑赢我多少比例的时候」 */
export function percentileRankOf(distribution, value) {
  const arr = Array.isArray(distribution) ? distribution : [];
  const v = Number(value);
  if (arr.length === 0 || !Number.isFinite(v)) return null;
  const below = arr.filter((x) => x < v).length;
  return round((below / arr.length) * 100, 1);
}

/**
 * 构建双基准对照（纯函数）。
 *
 * @param {object} o
 * @param {number[]} [o.closes]   该局已揭示区间的收盘价序列（与双盲推进顺序一致）
 * @param {number}   [o.returnPct] 本局实际收益率（%）
 * @param {number}   [o.sampleSize] 累计已平仓笔数（决定能不能给结论）
 * @param {number}   [o.seed]     决定论随机种子（建议用 sessionId，保证可复现）
 * @param {number}   [o.samples]  抽样次数
 */
export function buildDualBaseline(o) {
  const src = o && typeof o === 'object' ? o : {};
  const cs = closesOf(src);
  const rpRaw = src.returnPct;
  const rp = rpRaw === null || rpRaw === undefined || String(rpRaw).trim() === ''
    ? null
    : Number.isFinite(Number(rpRaw)) ? Number(rpRaw) : null;
  const n = Math.max(0, Math.floor(Number(src.sampleSize) || 0));
  const seed = Number.isFinite(Number(src.seed)) ? Number(src.seed) : 1;

  const insufficientData = cs.length < 2;
  const buyHoldPct = insufficientData ? null : round(holdReturnPct(cs, 0, cs.length - 1));
  const dist = insufficientData
    ? { samples: [], mean: null, stdev: null, n: 0 }
    : randomEntryDistribution(cs, { seed, samples: src.samples ?? RANDOM_SAMPLES });
  const randomEntryPct = dist.mean == null ? null : round(dist.mean);
  // 误差带：均值的标准误 ×1.96（95%），样本量越大带越窄——这是必须展示的部分，
  // 只给一个点估计会让「运气」看起来像「能力」。
  const bandHalf = dist.n > 0 && dist.stdev != null ? round(1.96 * (dist.stdev / Math.sqrt(dist.n)), 2) : null;
  const rank = rp == null ? null : percentileRankOf(dist.samples, rp);

  const beatBuyHold = rp == null || buyHoldPct == null ? null : rp > buyHoldPct;
  const beatRandom = rp == null || randomEntryPct == null ? null : rp > randomEntryPct;

  const ratioVisible = n >= RATIO_GUARD_THRESHOLD;
  const canConclude = n >= SAMPLE_THRESHOLD && rp != null && buyHoldPct != null && randomEntryPct != null;

  /** 方向（样本少也能说，因为它只是对照，不是对总体的推断） */
  let direction = null;
  if (rp != null && buyHoldPct != null && randomEntryPct != null) {
    if (beatBuyHold && beatRandom) direction = 'beat_both';
    else if (!beatBuyHold && !beatRandom) direction = 'beat_none';
    else if (beatBuyHold && !beatRandom) direction = 'beat_hold_only';
    else direction = 'beat_random_only';
  }

  const DIRECTION_TEXT = {
    beat_both: '同时跑赢「一直拿着」与「闭眼随便挑一天进场」，这一局的择时是加分项。',
    beat_none: '两个基准都没跑赢，这一局的收益更多来自行情本身。',
    beat_hold_only: '跑赢了「一直拿着」，但没跑赢「随便挑一天进场」——更可能是行情，不像择时。',
    beat_random_only: '跑赢了「随便挑一天进场」，但没跑赢「一直拿着」——低吸没带来优势。',
  };

  let verdict = null;
  if (insufficientData || rp == null) {
    verdict = { level: 'no-data', text: '结算并出成绩卡后，这里会同时给出两个基准。', conclusive: false };
  } else if (!canConclude) {
    verdict = {
      level: 'direction-only',
      text: `样本 ${n} 笔，不足 ${SAMPLE_THRESHOLD} 笔：这里只给对照方向，不给「策略有效」类结论。${DIRECTION_TEXT[direction] || ''}`,
      conclusive: false,
      remaining: Math.max(0, SAMPLE_THRESHOLD - n),
    };
  } else {
    verdict = {
      level: 'conclusive',
      text:
        `样本 ${n} 笔已达 ${SAMPLE_THRESHOLD} 笔：${DIRECTION_TEXT[direction] || ''}` +
        `随机入场基准 ${randomEntryPct >= 0 ? '+' : ''}${randomEntryPct}%` +
        (bandHalf != null ? `（95% 误差带 ±${bandHalf}%）` : '') + '。',
      conclusive: true,
    };
  }

  return {
    bars: cs.length,
    returnPct: rp == null ? null : round(rp),
    buyHoldPct,
    randomEntryPct,
    randomEntryBandHalf: bandHalf,
    randomEntryRange: bandHalf == null || randomEntryPct == null
      ? null
      : { low: round(randomEntryPct - bandHalf), high: round(randomEntryPct + bandHalf) },
    randomSamples: dist.n,
    percentileRank: ratioVisible ? rank : null,
    beatBuyHold,
    beatRandomEntry: beatRandom,
    direction,
    directionText: DIRECTION_TEXT[direction] || null,
    verdict,
    sampleSize: n,
    // 比率类护栏：与 RQ-95 同口径，不另设一套
    ratioVisible,
    conclusionThreshold: SAMPLE_THRESHOLD,
    ratioThreshold: RATIO_GUARD_THRESHOLD,
    method:
      `随机入场基准：同一标的、随机选取一个入场日、同样持有到最后一根，重复 ${dist.n} 次取均值；` +
      `种子取自训练局 ID，因此刷新页面结论不变（可复核）。`,
    disclaimer:
      '两个基准都只回答「这一局跑赢了什么」，不回答「策略长期是否有效」——后者需要 ' +
      `${SAMPLE_THRESHOLD} 笔以上样本，且必须带误差带看。`,
  };
}
