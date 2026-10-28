/**
 * 达标进度与「距下一档还差 N 笔」（RQ-117）
 *
 * v8 的护栏是**拦截**：不达标就不展示，达标了弹一次提示。
 * 用户看到的仍然是一片空白 + 一句「样本不足」，不知道自己离能看数字还差多远。
 * v9 把它改成**牵引**：未达标页面直接显示还差多少、以及现在能确定什么，
 * 达标当日提示一次且可关闭。
 *
 * 口径与体检单同源：档位与缺口一律复用 checkupService.resolveTier，不另算一套。
 */

import { resolveTier, SAMPLE_TIERS, RATIO_GUARD_THRESHOLD } from './checkupService.js';

/**
 * 构建达标进度（纯函数）。
 *
 * @param {object} o
 * @param {number} [o.sampleSize] 已平仓笔数
 * @param {number} [o.finishedRounds] 已完成局数（RQ-113 的净胜局门槛也用得上）
 * @param {string[]} [o.dismissed] 前端已关闭的提示 key
 * @param {Date|string} [o.now]
 */
export function buildTierProgress(o) {
  const src = o && typeof o === 'object' ? o : {};
  const n = Math.max(0, Math.floor(Number(src.sampleSize) || 0));
  const rounds = Math.max(0, Math.floor(Number(src.finishedRounds) || 0));
  const dismissed = new Set((Array.isArray(src.dismissed) ? src.dismissed : []).map(String));
  const now = src.now instanceof Date ? src.now : src.now ? new Date(src.now) : new Date();

  const tier = resolveTier(n);
  const reachedTop = Boolean(tier.reachedTop);

  // 关键差异：达标**之前**也要给出缺口，而不是留白
  const gates = [
    {
      key: 'ratio',
      label: `比率类指标（胜率 / 期望值）`,
      threshold: RATIO_GUARD_THRESHOLD,
      current: n,
      remaining: Math.max(0, RATIO_GUARD_THRESHOLD - n),
      reached: n >= RATIO_GUARD_THRESHOLD,
    },
    {
      key: 'tier',
      label: `可信度升到「${reachedTop ? tier.label : tier.next?.label ?? '—'}」档`,
      threshold: reachedTop ? tier.threshold : (tier.next?.threshold ?? 0),
      current: n,
      remaining: reachedTop ? 0 : Math.max(0, (tier.next?.threshold ?? 0) - n),
      reached: reachedTop,
    },
  ];

  // 达标当日提示：只在这一次出现（key 绑定当前笔数，笔数变了 key 也变 → 不会重复弹）
  const notices = [];
  for (const g of gates) {
    if (!g.reached) continue;
    const key = `tier:${g.key}:${g.threshold}`;
    if (dismissed.has(key)) continue;
    notices.push({
      key,
      kind: 'tier',
      title: `已跨过 ${g.threshold} 笔：${g.label}可读`,
      body: `当前 ${n} 笔。从这里开始看数字，但仍然要看误差带——${g.threshold} 笔只够看方向。`,
      cannot: '不承诺任何收益或奖励；这不构成投资建议。',
      once: true,
      dismissible: true,
      createdAt: new Date(Number.isNaN(now.getTime()) ? Date.now() : now.getTime()).toISOString(),
    });
  }

  const topTier = SAMPLE_TIERS[SAMPLE_TIERS.length - 1];

  return {
    sampleSize: n,
    finishedRounds: rounds,
    tier: { key: tier.key, label: tier.label, threshold: tier.threshold },
    next: reachedTop
      ? null
      : { key: tier.next?.key ?? null, label: tier.next?.label ?? null, threshold: tier.next?.threshold ?? 0 },
    remainingToNext: reachedTop ? 0 : Math.max(0, (tier.next?.threshold ?? 0) - n),
    reachedTop,
    gates,
    notices,
    progressPct: reachedTop
      ? 100
      : Math.min(
          100,
          Math.round(((n - tier.threshold) / Math.max(1, (tier.next?.threshold ?? 1) - tier.threshold)) * 100)
        ),
    topTierLabel: topTier?.label ?? '—',
    // RQ-117 的核心表达：未达标也要有话可说
    message: reachedTop
      ? `已达最高档「${tier.label}」，无需再凑样本。`
      : `当前 ${n} 笔（${tier.label}档），距下一档「${tier.next?.label ?? '—'}」还差 ${Math.max(0, (tier.next?.threshold ?? 0) - n)} 笔。`,
    note: '护栏从「拦截」改为「牵引」：未达标时显示还差多少，而不是留白。',
  };
}
