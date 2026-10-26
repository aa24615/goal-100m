/**
 * 站内提示（RQ-104）
 *
 * 两类提示，都要满足「出现一次、可关闭、数据与体检单同源」：
 *   ① 达标提示：样本笔数刚好落在档位门槛上（口径直接取自 checkup.milestone）；
 *   ② 周报提示：每周一条，给出段数 / 纪律执行率变化 / 距下一档缺口。
 *
 * 设计要点：
 *   - **每条都有稳定 key**：前端按 key 记录已读，服务端不存「已读」状态，
 *     避免为了一个 UI 开关往数据库里加列（也避免多端不一致）。
 *   - **不承诺任何实物或现金奖励**（合规硬约束）。
 *   - 周报提示的 key 按自然周生成，因此同一周内重复调用也只会出现一条。
 */

const DAY_MS = 86400 * 1000;

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 周 key（周四归属法，周一为一周起点） */
export function weekKeyOf(v) {
  const d = toDate(v) || new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // 周日 → 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // 移到本周周四
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 站内提示聚合（纯函数）。
 *
 * @param {object} o
 * @param {object|null} o.checkup buildCheckup 的结果
 * @param {object|null} o.weekly  summarizeWeekly 的结果
 * @param {Date|string} [o.now]
 * @param {string[]} [o.dismissed] 前端已关闭的 key
 */
export function buildInbox(o) {
  const { checkup = null, weekly = null, now = new Date(), dismissed = [] } =
    o && typeof o === 'object' ? o : {};
  const c = checkup && typeof checkup === 'object' ? checkup : {};
  const w = weekly && typeof weekly === 'object' ? weekly : {};
  const off = new Set(Array.isArray(dismissed) ? dismissed.map(String) : []);
  const base = toDate(now) || new Date();

  const items = [];

  // ① 达标提示：只在笔数**刚好**等于门槛时出现（RQ-80 的口径，避免每次刷新都弹）
  if (c.milestone && c.milestone.justReached) {
    const key = `milestone:${c.milestone.tierKey || 'unknown'}:${Number(c.sampleSize ?? 0)}`;
    if (!off.has(key)) {
      items.push({
        key,
        kind: 'milestone',
        title: `可信度升到「${c.milestone.tierLabel || '—'}」档`,
        body: c.milestone.message || '',
        cannot: c.milestone.cannot || '',
        once: true,
        dismissible: true,
        createdAt: base.toISOString(),
      });
    }
  }

  // ② 周报提示：一周一条
  const wk = weekKeyOf(base);
  const weeklyKey = `weekly:${wk}`;
  if (!off.has(weeklyKey)) {
    const seg = w.segments || {};
    const disc = w.discipline || {};
    const next = w.nextTier || {};
    const hasAny = Number(seg.thisWeek || 0) > 0 || Number(seg.lastWeek || 0) > 0;
    items.push({
      key: weeklyKey,
      kind: 'weekly',
      title: hasAny ? `本周训练周报（${wk}）` : `本周还没有训练记录（${wk}）`,
      body: hasAny
        ? `本周 ${seg.thisWeek} 段（上周 ${seg.lastWeek} 段）。${disc.note || ''} ${next.text || ''}`.trim()
        : '本周还没有结束任何一段训练。做一段盲测，周报就有内容了。',
      cannot: w.disclaimer || '不承诺任何收益或奖励。',
      once: true,
      dismissible: true,
      createdAt: base.toISOString(),
      action: { label: '去做一次训练', path: '/blind' },
    });
  }

  return {
    items,
    count: items.length,
    dismissed: [...off],
    // 关闭状态由前端保存并回传，服务端不持久化
    note: '每条提示出现一次且可关闭；关闭状态存本地，不写入服务端。',
  };
}
