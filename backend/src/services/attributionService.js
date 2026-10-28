/**
 * 获客归因落地（RQ-114 / F-37 / Q10）
 *
 * v8 把归因管道做好了，v9 复核发现**管道是空的**：6 个用户 `acquisition_channel` 全为 null。
 * 根因不是代码，是 RQ-106（无公网入口）——没有入口就没有链接，没有链接就没有渠道参数。
 * 因此 RQ-114 是 RQ-106 的**下游**：入口有了之后，这条管道必须立刻能读出「哪个渠道的人会练」。
 *
 * 设计取舍：
 *   1. **渠道白名单**（沿用 northStarService.ACQUISITION_CHANNELS）：未登记渠道一律归 unknown，
 *      避免任意字符串污染渠道口径——脏渠道比没有渠道更糟，因为它看起来像数据。
 *   2. **链接由服务端生成**：不让前端拼 URL，避免 utm_ 与 ref 两套参数漂移。
 *   3. **归因只登记渠道名**，不采集任何身份信息（硬约束 4）。
 */

import pool from '../db.js';
import { normalizeChannel, ACQUISITION_CHANNELS, UNKNOWN_CHANNEL } from './northStarService.js';

export { ACQUISITION_CHANNELS, UNKNOWN_CHANNEL, normalizeChannel };

export const CHANNEL_PARAM = 'ref';

/** 从任意 query / body 里解析渠道（兼容 ref / utm_source / channel 三种写法） */
export function channelFromQuery(q) {
  const src = q && typeof q === 'object' ? q : {};
  return normalizeChannel(src[CHANNEL_PARAM] ?? src.utm_source ?? src.channel ?? '');
}

/**
 * 生成可分享的带渠道链接。
 * 没有公网地址时**不产出 localhost 链接**——那会让人误以为已经可以分享了（F-30 的同类自欺）。
 */
export function buildShareLink(o) {
  const src = o && typeof o === 'object' ? o : {};
  const base = String(src.baseUrl || '').trim().replace(/\/+$/, '');
  const channel = normalizeChannel(src.channel);
  const path = String(src.path || '/').startsWith('/') ? String(src.path || '/') : `/${src.path || ''}`;

  if (!base) {
    return {
      ok: false,
      url: null,
      channel,
      reason: '尚未配置公网地址（PUBLIC_BASE_URL），无法生成可分享链接。请先完成 RQ-106。',
    };
  }
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    return {
      ok: false,
      url: null,
      channel,
      reason: '公网地址仍指向本机，生成的链接外部设备打不开。请先完成 RQ-106。',
    };
  }
  const u = new URL(path, `${base}/`);
  u.searchParams.set(CHANNEL_PARAM, channel);
  return {
    ok: true,
    url: u.toString(),
    channel,
    reason: null,
    note: '链接只携带渠道参数，不含任何身份信息；注册时该参数会落到 users.acquisition_channel。',
  };
}

/** 注册时把渠道落到用户行（幂等：已有值不覆盖，避免后续点击改写首次归因） */
export async function persistChannel(userId, rawChannel) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return { updated: false, channel: UNKNOWN_CHANNEL };
  const channel = normalizeChannel(rawChannel);
  const { rows } = await pool.query(
    `UPDATE users SET acquisition_channel = COALESCE(NULLIF(acquisition_channel, ''), $2)
      WHERE id = $1 RETURNING acquisition_channel`,
    [uid, channel]
  );
  return { updated: rows.length > 0, channel: rows[0]?.acquisition_channel || channel };
}

/**
 * 归因覆盖率（纯函数）。
 * RQ-114 验收：acquisition_channel 非空比例 ≥ 90%。
 */
export function coverageOf(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const known = list.filter((r) => {
    const c = normalizeChannel(r?.channel);
    return c !== UNKNOWN_CHANNEL;
  }).length;
  const rate = total > 0 ? Math.round((known / total) * 10000) / 100 : null;
  return {
    total,
    attributed: known,
    unknown: total - known,
    coveragePct: rate,
    targetPct: 90,
    pass: total > 0 && rate != null && rate >= 90,
    note:
      total === 0
        ? '暂无注册用户，覆盖率不可计算。'
        : `${known}/${total} 位用户可归因到渠道（${rate}%），目标 ≥90%。`,
  };
}

/** 各渠道首训完成率：复用 northStar 的聚合口径，不另算一套 */
export { normalizeChannel as normalize };
