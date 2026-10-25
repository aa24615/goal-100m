/**
 * 每周训练周报（RQ-86 / M5 留存引擎）
 *
 * 定位：给「练完就走」的用户一个回来的理由，因此周报必须**推着人往前走**，
 * 而不是复述一遍数字。三件事就够：
 *   ① 本周练了几段（量）
 *   ② 纪律执行率比上周变化了多少（质）
 *   ③ 距下一档可信度还差几笔（下一步）
 *
 * 硬约束：周报数据与体检单**同源**（样本笔数、档位口径直接取自 checkup），
 * 不允许另算一套；且**不承诺任何实物或现金奖励**（合规底线）。
 *
 * 核心聚合是纯函数（summarizeWeekly），DB 版本只负责取数 —— 便于单测覆盖边界。
 */

import pool from '../db.js';
import { resolveTier } from './checkupService.js';

const DAY_MS = 86400 * 1000;

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function avg(nums) {
  const list = nums.filter((n) => Number.isFinite(n));
  if (list.length === 0) return null;
  return Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 100) / 100;
}

/**
 * 周报聚合（纯函数）。
 *
 * @param {object} o
 * @param {Array}  o.sessions  [{ finishedAt, score }]，score 含 disciplineRate / returnPct
 * @param {object|null} o.checkup 体检单（提供 sampleSize 与档位口径）
 * @param {Date|string|number} o.now 基准时间
 * @param {number} o.weekDays  窗口天数（默认 7）
 */
export function summarizeWeekly(o) {
  // 与 buildCheckup 同理：解构默认值兜不住整个入参为 null，
  // 而周报是只读展示，不该因为入参为空把页面打成 500。
  const { sessions = [], checkup = null, now = new Date(), weekDays = 7 } = o && typeof o === 'object' ? o : {};
  const list = Array.isArray(sessions) ? sessions : [];
  const base = toDate(now) || new Date();
  const w = Math.max(1, Math.floor(Number(weekDays) || 7));
  const end = base.getTime();
  const start = end - w * DAY_MS;
  const prevStart = start - w * DAY_MS;

  const inRange = (t, lo, hi) => {
    const d = toDate(t);
    return d ? d.getTime() >= lo && d.getTime() < hi : false;
  };

  const thisWeek = list.filter((s) => inRange(s?.finishedAt, start, end + DAY_MS));
  const lastWeek = list.filter((s) => inRange(s?.finishedAt, prevStart, start));

  const rate = (arr) => avg(arr.map((s) => Number(s?.score?.disciplineRate)).filter((n) => Number.isFinite(n)));
  const thisRate = rate(thisWeek);
  const lastRate = rate(lastWeek);

  // 纪律执行率变化：任何一侧无数据都返回 null —— 「上周没练」不是「上周 0%」
  const delta = thisRate != null && lastRate != null ? Math.round((thisRate - lastRate) * 100) / 100 : null;

  const sampleSize = Number(checkup?.sampleSize ?? checkup?.progress?.sampleSize ?? 0);
  // 口径与体检单同源：直接用同一份 resolveTier，避免两套门槛算法
  const tier = resolveTier(Number.isFinite(sampleSize) ? sampleSize : 0);

  const tagCount = {};
  for (const s of thisWeek) {
    const t = s?.segmentTag || 'unknown';
    tagCount[t] = (tagCount[t] || 0) + 1;
  }

  return {
    window: { days: w, from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) },
    segments: {
      thisWeek: thisWeek.length,
      lastWeek: lastWeek.length,
      delta: thisWeek.length - lastWeek.length,
      byTag: tagCount,
    },
    discipline: {
      thisWeek: thisRate,
      lastWeek: lastRate,
      delta,
      // 无对比基线时明确说明，而不是显示「变化 0」
      note:
        delta == null
          ? '本周或上周没有可比的纪律执行率数据，暂不给出变化。'
          : delta > 0
            ? `纪律执行率较上周提升 ${delta} 个百分点。`
            : delta < 0
              ? `纪律执行率较上周下降 ${Math.abs(delta)} 个百分点。`
              : '纪律执行率与上周持平。',
    },
    nextTier: {
      tierKey: tier.key,
      tierLabel: tier.label,
      sampleSize,
      remaining: tier.remaining,
      nextTierLabel: tier.next?.label ?? null,
      nextThreshold: tier.next?.threshold ?? null,
      text: tier.reachedTop
        ? `已达最高档「${tier.label}」，保持住就行。`
        : `还差 ${tier.remaining} 笔升到「${tier.next.label}」档`,
    },
    // 合规硬约束：周报不得承载任何奖励承诺
    disclaimer: '本训练周报基于模拟交易行为统计，不构成投资建议，不承诺任何收益或奖励。',
    empty: thisWeek.length === 0 && lastWeek.length === 0,
  };
}

/** 从 DB 取数生成周报 */
export async function weeklyReport(userId, { weekDays = 7, checkup = null, now = new Date() } = {}) {
  const w = Math.max(1, Math.floor(Number(weekDays) || 7));
  const { rows } = await pool.query(
    `SELECT id, status, score, finished_at, segment_tag
       FROM blind_sessions
      WHERE user_id=$1 AND finished_at IS NOT NULL
        AND finished_at >= now() - ($2 || ' days')::interval
      ORDER BY finished_at DESC
      LIMIT 500`,
    [userId, String(w * 2 + 1)]
  );
  const sessions = rows.map((r) => ({
    id: r.id,
    finishedAt: r.finished_at,
    score: r.score,
    segmentTag: r.segment_tag || null,
  }));
  return summarizeWeekly({ sessions, checkup, now, weekDays: w });
}

export { DAY_MS };
