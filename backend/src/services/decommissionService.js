/**
 * 零使用功能下线（RQ-116 / F-39 / F-44 / Q9）
 *
 * v8 做成了「折叠」：把 /scenarios 与 /rooms 移出一级导航。v9 复核判定**不够**——
 * 路由、服务与埋点都还在，结果是：
 *   - 产品侧持续维护两套世界观（剧本训练用合成行情，双盲用真实历史），成绩不可比（F-44）；
 *   - 用户侧老书签 / 直达地址进来的仍是空页面，且没有任何解释（F-39）。
 *
 * 因此本期**下线而非折叠**：
 *   - 路由返回 410 Gone + 明确归档说明，而不是 404（404 会被当成故障）；
 *   - 页面显式标注「已归档」并指向替代路径（双盲训练）；
 *   - 服务与埋点不再产生新数据。
 */

export const ARCHIVE_DATE = '2026-10-28';

export const DECOMMISSIONED = [
  {
    path: '/scenarios',
    label: '剧本训练场',
    apiPrefix: '/api/scenario',
    archivedAt: ARCHIVE_DATE,
    reason: '合成行情与真实历史两套世界观会让成绩不可比（F-44），且使用量为 1 次。',
    replacement: { path: '/blind', label: '双盲训练（真实历史行情）' },
  },
  {
    path: '/rooms',
    label: '房间赛',
    apiPrefix: '/api/rooms',
    archivedAt: ARCHIVE_DATE,
    reason: '房间赛使用量为 0；大赛与社区属券商主场（600 万级用户 + 交易所背书），不在我们的可赢范围。',
    replacement: { path: '/training', label: '训练中心（每日一题与净胜局）' },
  },
];

export function isDecommissioned(path) {
  const p = String(path ?? '');
  return DECOMMISSIONED.find((d) => p === d.path || p.startsWith(`${d.apiPrefix}`)) || null;
}

/** 归档响应体：410 Gone + 可执行的下一步，而不是裸 404 */
export function archivedPayload(path) {
  const d = isDecommissioned(path);
  if (!d) return null;
  return {
    archived: true,
    status: 410,
    feature: d.label,
    path: d.path,
    archivedAt: d.archivedAt,
    reason: d.reason,
    message: `${d.label}已于 ${d.archivedAt} 归档，不再维护。`,
    replacement: d.replacement,
    note: '归档不等于故障：这是主动下线，历史数据不再产生新记录。',
  };
}

/** 守护：给定服务/埋点清单，检查归档功能是否仍在产生数据 */
export function assertNoTraffic(eventCounts = {}) {
  const c = eventCounts && typeof eventCounts === 'object' ? eventCounts : {};
  const violations = [];
  for (const d of DECOMMISSIONED) {
    for (const key of Object.keys(c)) {
      if (key.startsWith('room_') && d.path === '/rooms' && Number(c[key]) > 0) {
        violations.push({ path: d.path, event: key, count: c[key] });
      }
      if (key.startsWith('scenario') && d.path === '/scenarios' && Number(c[key]) > 0) {
        violations.push({ path: d.path, event: key, count: c[key] });
      }
    }
  }
  return { ok: violations.length === 0, violations, checkedAt: ARCHIVE_DATE };
}
