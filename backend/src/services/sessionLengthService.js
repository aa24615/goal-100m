/**
 * 局长度档位（RQ-107 / I-8 短局化 / F-31 / F-35）
 *
 * 真实数据：`blind_finish` 埋点 **0 条**，会话表里 2 条会话全部 RUNNING，
 * 进度 15/60 与 0/60 根。默认一局 60 根、每 10 根一次决策 → 完整走完要 6 次判断。
 * 这与「碎片时间训练」的定位直接冲突：用户要下决心才能开始一次（F-35），
 * 而一旦中断就永远停在半路（F-31）。
 *
 * 短局化是本期与竞品唯一的**节奏差异**：竞品普遍在加长局（100/200 日长局是付费卖点），
 * 短局无人做。因此默认改为快局，长局保留为进阶选项但不再是默认。
 *
 * 纯函数模块：前端与后端共用同一份档位定义，避免页面写死 60 而后端口径变了。
 */

/** 每 N 根 K 线要求记录一次决策（与 blindService.DECISION_INTERVAL 一致） */
export const DECISION_INTERVAL = 10;

/**
 * 局长度档位。
 * quick 为默认（RQ-107 验收：默认一局 ≤15 根、1–2 次决策即结算）。
 */
export const BAR_PRESETS = [
  {
    key: 'quick',
    label: '快局',
    bars: 12,
    decisionInterval: DECISION_INTERVAL,
    default: true,
    advanced: false,
    desc: '12 根 K 线，1–2 次判断，约 1 分钟',
    bestFor: '第一次训练与碎片时间',
  },
  {
    key: 'standard',
    label: '标准局',
    bars: 60,
    decisionInterval: DECISION_INTERVAL,
    default: false,
    advanced: false,
    desc: '60 根 K 线，最多 6 次判断',
    bestFor: '想完整走一段趋势',
  },
  {
    key: 'long',
    label: '长局',
    bars: 120,
    decisionInterval: DECISION_INTERVAL,
    default: false,
    advanced: true,
    desc: '120 根 K 线，最多 12 次判断',
    bestFor: '进阶：练拿不拿得住',
  },
  {
    key: 'epic',
    label: '超长局',
    bars: 200,
    decisionInterval: DECISION_INTERVAL,
    default: false,
    advanced: true,
    desc: '200 根 K 线，最多 20 次判断',
    bestFor: '进阶：练多段行情的连续性',
  },
];

export const DEFAULT_PRESET_KEY = 'quick';
/** RQ-107 验收口径：默认一局 ≤15 根 */
export const DEFAULT_BARS = 12;
export const MAX_DEFAULT_BARS = 15;
/** 短局后最小可取长度由 20 下调到 10 */
export const MIN_BARS = 10;
export const MAX_BARS = 200;

export function presetOf(key) {
  const k = String(key ?? '').trim().toLowerCase();
  return BAR_PRESETS.find((p) => p.key === k) || null;
}

/**
 * 解析局长度：接受档位 key、数字根数，或为空（取默认）。
 *
 * 关键取舍：**非法输入一律回落到默认快局，不抛错**。
 * 首训路径上任何一次 400 都会把用户挡在第一次判断之外（F-33 的同类错误）。
 */
export function resolveSessionLength(input) {
  const fallback = presetOf(DEFAULT_PRESET_KEY);
  if (input == null || input === '') return { ...fallback, source: 'default' };

  // 先看是不是档位 key
  const byKey = presetOf(input);
  if (byKey) return { ...byKey, source: 'preset' };

  const n = Number(input);
  if (!Number.isFinite(n)) return { ...fallback, source: 'default' };

  const bars = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.floor(n)));
  const exact = BAR_PRESETS.find((p) => p.bars === bars);
  if (exact) return { ...exact, source: 'preset' };
  return {
    key: 'custom',
    label: '自定义',
    bars,
    decisionInterval: DECISION_INTERVAL,
    default: false,
    advanced: bars > 60,
    desc: `${bars} 根 K 线`,
    bestFor: '自定义长度',
    source: 'custom',
  };
}

/** 预期决策点数量：短局化验收要求「1–2 次决策即结算」 */
export function decisionPointsFor(bars) {
  const n = Number.isFinite(Number(bars)) ? Math.max(MIN_BARS, Math.floor(Number(bars))) : DEFAULT_BARS;
  return Math.max(1, Math.floor(n / DECISION_INTERVAL));
}

/** 默认档位是否达标（自测守护：防止有人悄悄把默认改回 60） */
export function isShortByDefault() {
  const d = BAR_PRESETS.find((p) => p.default) || presetOf(DEFAULT_PRESET_KEY);
  return Boolean(d) && d.bars <= MAX_DEFAULT_BARS && decisionPointsFor(d.bars) <= 2;
}
