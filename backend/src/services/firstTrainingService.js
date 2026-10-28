/**
 * 首训引导漏斗（RQ-110 / F-33 / F-43）
 *
 * v9 实地复核：引导式首训（RQ-92）**一次都没被走到**——
 * `first_training_start` / `first_training_decision` 埋点 0 条，而 `blind_start` 有 5 条。
 * 也就是说 2 次训练会话都不是从「做一次训练」那张引导卡片进来的。
 *
  * 但更糟的是当前埋点**不足以定位断点**：只有 start 与 decision 两个点，
 * 无法区分「卡片没被看到」「看到了没点」「点了没进训练页」。
 * RQ-110 因此把引导路径补成四步：进入 → 开始 → 决策 → 结算。
 *
 * 纯函数聚合 + DB 取数分离，便于无库单测（沿用 v8 的服务分层约定）。
 */

import pool from '../db.js';

/** 引导路径四步（顺序即漏斗顺序，不可调换） */
export const GUIDE_STEPS = [
  { key: 'first_training_enter', label: '进入训练中心（看到引导卡片）' },
  { key: 'first_training_start', label: '点击开始第一次训练' },
  { key: 'first_training_decision', label: '提交第一次判断' },
  { key: 'first_training_finish', label: '结算并出成绩卡' },
];

export const GUIDE_EVENTS = GUIDE_STEPS.map((s) => s.key);

/**
 * 引导漏斗聚合（纯函数）。
 *
 * @param {object} counts 形如 { first_training_enter: 12, first_training_start: 3, ... }
 * @param {object} [o]
 * @param {number} [o.medianSec] 开始 → 结算的中位耗时（秒）
 */
export function summarizeGuideFunnel(counts = {}, o = {}) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const opts = o && typeof o === 'object' ? o : {};
  const int0 = (v) => Math.max(0, Math.floor(Number(v) || 0));

  const steps = GUIDE_STEPS.map((s) => ({ ...s, count: int0(c[s.key]) }));
  const enter = steps[0].count;

  const funnel = steps.map((s, i) => {
    const prev = i === 0 ? s.count : steps[i - 1].count;
    return {
      ...s,
      // 首步没有上一步，转化率按自身计 100%
      conversionFromPrev: prev > 0 ? Math.round((s.count / prev) * 10000) / 100 : null,
      conversionFromEnter: enter > 0 ? Math.round((s.count / enter) * 10000) / 100 : null,
    };
  });

  // 断点：第一个「上一步有人、这一步没人」的位置
  let dropAt = null;
  for (let i = 1; i < funnel.length; i += 1) {
    if (steps[i - 1].count > 0 && steps[i].count === 0) {
      dropAt = { step: funnel[i].key, label: funnel[i].label, after: funnel[i - 1].key };
      break;
    }
  }

  const started = int0(c.first_training_start);
  const finished = int0(c.first_training_finish);
  const med = Number.isFinite(Number(opts.medianSec)) ? Number(opts.medianSec) : null;

  return {
    steps: funnel,
    dropAt,
    summary: {
      entered: enter,
      started,
      decided: int0(c.first_training_decision),
      finished,
      // RQ-109 口径：完成 = 结算出成绩卡，不再是「第一次决策」
      completionRate: started > 0 ? Math.round((finished / started) * 10000) / 100 : null,
      medianSecToFinish: med == null ? null : Math.round(med * 100) / 100,
    },
    // F-43 的守护：埋点全 0 必须显式说明「不可判定」，不能被当成「已验证」
    note:
      enter === 0
        ? '引导路径四步全部为 0：无法判定是入口不可见、文案无效还是用户不走引导。请先用真实设备走一次。'
        : dropAt
          ? `断点出现在「${dropAt.label}」之前。`
          : '四步均有数据，引导路径可验证。',
  };
}

/** 从 DB 取数（RQ-110）：按事件分组计数 + 开始→结算的中位耗时 */
export async function guideFunnel({ days = 30 } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await pool.query(
    `SELECT event, COUNT(*)::int AS cnt
       FROM analytics_events
      WHERE event = ANY($1::text[]) AND created_at >= now() - ($2 || ' days')::interval
      GROUP BY event`,
    [GUIDE_EVENTS, String(d)]
  );
  const counts = {};
  for (const r of rows) counts[r.event] = r.cnt;

  const { rows: dur } = await pool.query(
    `WITH pairs AS (
       SELECT a.user_id,
              MIN(a.created_at) FILTER (WHERE a.event = 'first_training_start') AS t0,
              MIN(b.created_at) FILTER (WHERE b.event = 'first_training_finish') AS t1
         FROM analytics_events a
         JOIN analytics_events b ON b.user_id = a.user_id
        WHERE a.event = 'first_training_start'
          AND b.event = 'first_training_finish'
          AND b.created_at >= a.created_at
          AND a.created_at >= now() - ($1 || ' days')::interval
        GROUP BY a.user_id
     )
     SELECT EXTRACT(EPOCH FROM (t1 - t0)) AS sec FROM pairs WHERE t1 IS NOT NULL`,
    [String(d)]
  );
  const secs = dur.map((r) => Number(r.sec)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const medianSec = secs.length
    ? secs.length % 2 === 1
      ? secs[Math.floor(secs.length / 2)]
      : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2
    : null;

  return { days: d, ...summarizeGuideFunnel(counts, { medianSec }) };
}
