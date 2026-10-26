/**
 * 训练成绩卡（RQ-99 / I-5）
 *
 * 要解决的问题是 F-24：**训练成绩带不走**。
 * 一次训练结束只留在自己的历史列表里，练完即走，既没有回来的理由，
 * 也没有对外分享的抓手。
 *
 * 成绩卡的设计取舍：
 *   1. **数字与体检单同源**——档位与缺口一律复用 checkupService.resolveTier，
 *      不另算一套，否则用户会看到两个互相打架的「还差 N 笔」。
 *   2. **可复制为纯文本**——不依赖截图、不依赖登录态，复制即可带走。
 *   3. **不承诺任何实物或现金奖励**（合规硬约束）。
 *
 * 构建是纯函数：入参残缺时降级为可读文案而不是抛错。
 */

import { resolveTier, RATIO_GUARD_THRESHOLD } from './checkupService.js';
import { SEGMENT_TAGS } from './blindService.js';

const ACTION_LABEL = { BUY: '买入', SELL: '卖出', HOLD: '观望' };

function num(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/**
 * 构建成绩卡（纯函数）。
 *
 * @param {object} o
 * @param {object} o.session    blind_sessions 行（含 alias / status / segment_tag / granularity）
 * @param {object} o.score      buildBlindScore 的结果
 * @param {number} [o.sampleSize] 体检单里的已平仓笔数（用于算「距下一档」）
 */
export function buildScoreCard(o) {
  const { session = null, score = null, sampleSize } = o && typeof o === 'object' ? o : {};
  const s = session && typeof session === 'object' ? session : {};
  const sc = score && typeof score === 'object' ? score : {};

  const n = Number.isFinite(Number(sampleSize)) ? Math.max(0, Math.floor(Number(sampleSize))) : 0;
  const tier = resolveTier(n);

  const tagKey = s.segment_tag || null;
  const tagLabel = tagKey ? SEGMENT_TAGS[tagKey]?.label || tagKey : '未知';
  const finished = String(s.status || '').toUpperCase() === 'FINISHED';

  const returnPct = Number.isFinite(Number(sc.returnPct)) ? Number(sc.returnPct) : null;
  const discipline = Number.isFinite(Number(sc.disciplineRate)) ? Number(sc.disciplineRate) : null;

  const lines = [
    `标的：${finished ? `${s.stock_name || '—'}（${s.stock_code || '—'}）` : `${s.alias || '—'}（训练中，身份未揭示）`}`,
    `片段类型：${tagLabel}｜粒度：${s.granularity || 'day'}`,
    `收益率：${returnPct == null ? '—' : `${returnPct >= 0 ? '+' : ''}${num(returnPct)}%`}`,
    `纪律执行率：${discipline == null ? '未生成（尚无决策记录）' : `${num(discipline)}%`}`,
    `本次决策点：${num(Number(sc.decisionPoints) || 0, 0)} 个，交易 ${num(Number(sc.tradeCount) || 0, 0)} 笔`,
    `累计样本：${n} 笔，当前可信度「${tier.label}」档`,
    tier.reachedTop
      ? '已达最高档，无需再凑样本。'
      : `距下一档「${tier.next.label}」还差 ${tier.remaining} 笔`,
  ];

  // RQ-95 护栏：样本太小时不往成绩卡里塞任何比率类断言
  if (n < RATIO_GUARD_THRESHOLD) {
    lines.push(`样本 ${n} 笔 < ${RATIO_GUARD_THRESHOLD} 笔护栏，本卡不给出胜率 / 期望值类结论。`);
  }

  const text = ['【训练成绩卡 · 赚一个小目标】', ...lines, sc.disclaimer || '模拟训练成绩基于真实历史行情，不构成投资建议，不承诺任何收益。'].join(
    '\n'
  );

  return {
    title: '训练成绩卡',
    subtitle: finished ? '已揭示标的身份' : '训练进行中（成绩为临时值）',
    lines,
    text,
    copyable: true,
    // 硬约束：不承诺任何实物或现金奖励
    disclaimer: sc.disclaimer || '模拟训练成绩基于真实历史行情，不构成投资建议，不承诺任何收益或奖励。',
    tier: { key: tier.key, label: tier.label, remaining: tier.remaining, nextLabel: tier.next?.label ?? null },
  };
}

export { ACTION_LABEL };
