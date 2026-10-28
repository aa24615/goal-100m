/**
 * 小样本「仍然能说的三件事」（RQ-111 / I-7 / F-34）
 *
 * 行业方法论已经很清楚（tradejournal.ai / TradeLyser / pipjournal.ai）：
 *   - **成本事实不需要样本**：手续费与滑点损耗是本局已发生的事实，2 笔也算得出来；
 *   - **行为事实只需要计数，不需要推断**：止损执行率、追高比例、持有时长分布是计数，
 *     不是对未来的推断，因此不受样本量护栏限制；
 *   - **只有 edge 主张才需要数百笔**：胜率、期望值（R）、排名属于对总体的推断，
 *     30 笔时连正负号都确定不了（95% 区间约 ±0.54R）。
 *
 * 竞品在样本不足时给的是**空白页或门槛拦截**，而我们可以给「你现在能确定的三件事」。
 * 这是 v9 判定为「唯一仍在的差异化窗口」的落地核心。
 *
 * 硬约束 3：样本门槛与误差带不得因「页面太空」被砍——空页面要用这三条补位。
 */

import { RATIO_GUARD_THRESHOLD } from './checkupService.js';

/** 低于此笔数即进入「小样本」表达（与 RQ-95 的 30 笔护栏同源，不另设一套） */
export const SMALL_SAMPLE_THRESHOLD = RATIO_GUARD_THRESHOLD;

/** 这三件事在小样本下**仍然可说**；其余一律属于 edge 主张，必须拦住 */
export const SAYABLE_KEYS = ['cost', 'behavior', 'benchmark'];

/** 小样本下**禁止出现**的断言（守护口径，防止页面为了填满而塞伪结论） */
export const FORBIDDEN_ASSERTIONS = ['胜率', '期望值', '平均 R', '排名', '收益率排名', '策略有效'];

function int0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function num(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n).toFixed(d) : null;
}

function pct(v, d = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : null;
}

/**
 * 构建小样本可说的事实（纯函数）。
 *
 * @param {object} o
 * @param {number} [o.sampleSize]     已平仓笔数
 * @param {object} [o.cost]            { fee, slippage, turnover }
 * @param {object} [o.behavior]        { stopExecuted, stopPlanned, chaseHigh, closed, avgHoldDays, medianHoldDays }
 * @param {object} [o.benchmark]       { returnPct, buyHoldPct }
 */
export function buildSmallSampleFacts(o) {
  const src = o && typeof o === 'object' ? o : {};
  const n = int0(src.sampleSize);
  const cost = src.cost && typeof src.cost === 'object' ? src.cost : {};
  const beh = src.behavior && typeof src.behavior === 'object' ? src.behavior : {};
  const bench = src.benchmark && typeof src.benchmark === 'object' ? src.benchmark : {};

  const isSmall = n < SMALL_SAMPLE_THRESHOLD;
  const facts = [];

  /* ① 成本事实：不需要样本，是本局已发生的事实 */
  const fee = Number(cost.fee);
  const slippage = Number(cost.slippage);
  const turnover = Number(cost.turnover);
  const hasCost = Number.isFinite(fee) || Number.isFinite(slippage) || Number.isFinite(turnover);
  facts.push({
    key: 'cost',
    kind: '成本事实',
    available: hasCost,
    headline: hasCost
      ? `已付出手续费 ${num(fee || 0)} 元、滑点损耗 ${num(slippage || 0)} 元`
      : '暂无成交，还没有产生手续费与滑点',
    detail: hasCost
      ? `累计成交额 ${num(turnover || 0)} 元。这部分是本局已经发生的成本，与样本多少无关，可以现在就确认。`
      : '完成第一笔成交后即可读出你的真实交易成本。',
    needsSample: false,
  });

  /* ② 行为事实：只需要计数，不需要推断 */
  const planned = int0(beh.stopPlanned);
  const executed = int0(beh.stopExecuted);
  const closed = int0(beh.closed) || n;
  const chase = int0(beh.chaseHigh);
  const hasBehavior = planned > 0 || closed > 0 || chase > 0;
  const stopRate = planned > 0 ? executed / planned : null;
  const chaseRate = closed > 0 ? chase / closed : null;
  const holdText = Number.isFinite(Number(beh.medianHoldDays))
    ? `持仓时长中位数 ${num(beh.medianHoldDays, 1)} 天`
    : null;
  facts.push({
    key: 'behavior',
    kind: '行为事实',
    available: hasBehavior,
    headline: hasBehavior
      ? [
          planned > 0 ? `止损计划 ${planned} 次、执行 ${executed} 次（${pct(stopRate)}）` : null,
          chaseRate != null ? `追高买入 ${chase}/${closed} 笔（${pct(chaseRate)}）` : null,
          holdText,
        ]
          .filter(Boolean)
          .join('；') || '已有成交记录，行为计数可读'
      : '还没有计划或成交记录，行为事实待积累',
    detail: '这些只是计数，不是对未来的推断，因此不受样本量护栏限制——现在就能确认你「做到了没有」。',
    needsSample: false,
  });

  /* ③ 对照事实：与买入持有比，样本少也能比 */
  const rp = Number(bench.returnPct);
  const bp = Number(bench.buyHoldPct);
  const hasBench = Number.isFinite(rp) && Number.isFinite(bp);
  const diff = hasBench ? rp - bp : null;
  facts.push({
    key: 'benchmark',
    kind: '对照事实',
    available: hasBench,
    headline: hasBench
      ? `本局 ${rp >= 0 ? '+' : ''}${num(rp)}% vs 买入持有 ${bp >= 0 ? '+' : ''}${num(bp)}%`
      : '结算一局后即可与「一直拿着」对照',
    detail: hasBench
      ? `单次对照不说明策略好坏，只回答「这一局跑赢了什么」；多次对照的累加才是净胜局（RQ-113）。`
      : '完成一次结算即可读出这个对照。',
    needsSample: false,
    netWin: hasBench ? (diff > 0 ? 1 : diff < 0 ? -1 : 0) : null,
  });

  /* 下一步动作：小样本时给唯一动作，不许给 edge 结论 */
  const remaining = Math.max(0, SMALL_SAMPLE_THRESHOLD - n);
  const nextAction = isSmall
    ? {
        label: `再积累 ${remaining} 笔，胜率与期望值才可读`,
        hint: '在此之前，页面只展示上面三件事——不是因为算不出来，而是因为算出来也不能信。',
        cta: '/blind',
      }
    : { label: '样本已达护栏，比率类指标可读', hint: '可以开始看胜率与期望值，但仍要带上误差带。', cta: '/review' };

  const banned = FORBIDDEN_ASSERTIONS.slice();

  return {
    sampleSize: n,
    smallSample: isSmall,
    threshold: SMALL_SAMPLE_THRESHOLD,
    facts,
    sayableCount: facts.filter((f) => f.available).length,
    nextAction,
    // 页面必须原样展示这段，避免用户把「没展示」理解成「为 0」
    blockedAssertions: isSmall ? banned : [],
    disclaimer: `样本 ${n} 笔：成本、行为与对照三类事实不需要样本即可确认；胜率与期望值需 ${SMALL_SAMPLE_THRESHOLD} 笔以上，在此之前一律不展示。`,
  };
}

/**
 * 守护：给定一段展示文本，检查是否在小样本下出现了 edge 类断言。
 * 供单测使用——「页面太空就塞点数字进去」是 F-32 同类错误的复发路径。
 */
export function assertNoEdgeAssertion(text, sampleSize) {
  const s = String(text ?? '');
  const n = int0(sampleSize);
  if (n >= SMALL_SAMPLE_THRESHOLD) return { ok: true, hits: [], sampleSize: n };
  const hits = FORBIDDEN_ASSERTIONS.filter((w) => s.includes(w));
  return { ok: hits.length === 0, hits, sampleSize: n };
}
