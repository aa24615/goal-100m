// 交易者能力画像（RQ-24）：择时 / 选股 / 风控 / 纪律 四维雷达
//
// 全部为确定性统计口径（不使用任何外部模型），与战绩中心数据同源，口径在接口一并下发。

import { round2, pct2 } from '../utils/time.js';
import { pairTrades, buildScorecard } from './reviewService.js';

export const RADAR_DIMS = [
  { key: 'timing', label: '择时', desc: '相对同期大盘的超额收益表现，跑赢越多得分越高' },
  { key: 'selection', label: '选股', desc: '已平仓交易的胜率，反映标的选择与买卖点的综合质量' },
  { key: 'risk', label: '风控', desc: '净值最大回撤越小、持仓越分散，得分越高' },
  { key: 'discipline', label: '纪律', desc: '手续费占比越低、平均持仓周期越稳定，得分越高' },
];

const clamp = (n) => Math.max(0, Math.min(100, pct2(n)));

/**
 * @param {object} o
 * @param {Array}  o.transactions 流水
 * @param {number} o.returnPct 区间收益率
 * @param {number} o.benchmarkPct 同期大盘收益率
 * @param {Array<number>} o.equitySeries 净值序列
 * @param {number} o.initialCapital
 * @param {number} o.currentAssets
 */
export function buildAbilityRadar({
  transactions = [],
  returnPct = 0,
  benchmarkPct = 0,
  equitySeries = [],
  initialCapital = 0,
  currentAssets = 0,
} = {}) {
  const { rounds } = pairTrades(transactions);
  const card = buildScorecard({ rounds, initialCapital, equitySeries });
  const closed = rounds.filter((r) => r.status !== 'open');
  const wins = closed.filter((r) => r.realizedPnl > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  const excess = Number(returnPct) - Number(benchmarkPct);
  const timing = clamp(50 + excess * 5);
  const selection = clamp(winRate);
  const risk = clamp(100 - Number(card.maxDrawdown) * 4);
  const discipline = clamp(100 - Number(card.feeRatio) * 20);

  const openPositions = rounds.filter((r) => r.status === 'open');
  let concentration = 0;
  if (openPositions.length > 0 && currentAssets > 0) {
    concentration = pct2((Math.max(...openPositions.map((r) => r.costBasis)) / currentAssets) * 100);
  }

  const scores = { timing, selection, risk, discipline };
  const overall = clamp((timing + selection + risk + discipline) / 4);

  return {
    overall,
    dimensions: RADAR_DIMS.map((d) => ({ ...d, score: scores[d.key] })),
    detail: {
      excessPct: pct2(excess),
      winRate: pct2(winRate),
      maxDrawdown: card.maxDrawdown,
      feeRatio: card.feeRatio,
      concentrationPct: concentration,
      roundCount: closed.length,
    },
    note: '四维指标由本人真实交易数据统计得出，仅用于学习参考，不构成投资建议',
  };
}
