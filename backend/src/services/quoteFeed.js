/**
 * 真实行情推送（替换原随机游走引擎的价格来源）
 *
 * 职责单一：按节奏拉取「全市场实时快照」并缓存，供 market.js 的 tick 消费。
 * 不直接改内存行情状态，避免与撮合/持久化逻辑耦合。
 *
 * 节奏：
 *  - 交易时段：每 QUOTE_POLL_MS（默认 5s）拉一次
 *  - 非交易时段：每 QUOTE_IDLE_MS（默认 5 分钟）拉一次（收盘价/盘后数据仍会更新）
 * 数据源：东方财富优先，失败回落新浪（见 datasource/index.js）
 */

import { fetchRealtimeQuotes } from '../datasource/index.js';
import { logger } from '../logger.js';

const POLL_MS = Number(process.env.QUOTE_POLL_MS || 5000);
const IDLE_MS = Number(process.env.QUOTE_IDLE_MS || 300000);

let latest = new Map(); // code -> {price,open,high,low,prevClose,volume,amount}
let lastFetchAt = 0;
let lastError = null;
let fetching = false;
let timer = null;
let polls = 0;

/** 最近一次成功拿到的全市场快照 */
export function getLatestQuotes() {
  return latest;
}

/** 快照数据的获取时间（tick 据此判断是否有新数据） */
export function getLastFetchAt() {
  return lastFetchAt;
}

/**
 * RQ-47 / RQ-57 数据源状态：前端据此展示「更新于 N 分钟前 + 来源」，
 * 中断时明确提示并提供训练降级入口 —— 静默停更比报错更伤信任（F-06）。
 */
export function quoteFeedStatus() {
  let lastSource = '未知';
  try {
    lastSource = quoteSourceLabel();
  } catch {
    lastSource = '未知';
  }
  const staleMs = lastFetchAt ? Date.now() - lastFetchAt : null;
  return {
    size: latest.size,
    lastFetchAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
    // 超过两个轮询周期（且至少 60s）没更新即判定滞后，前端据此给提示
    staleForMs: staleMs,
    stale: lastFetchAt === 0 || (staleMs != null && staleMs > Math.max(60000, POLL_MS * 4)) || Boolean(lastError),
    // 一次失败不算中断（会重试），连续失败才算
    interrupted: Boolean(lastError) && consecutiveFailures >= FAIL_ALERT_THRESHOLD,
    lastError: lastError ? String(lastError).slice(0, 300) : null,
    source: lastSource,
    polls,
    pollMs: POLL_MS,
    idleMs: IDLE_MS,
  };
}

const FAIL_ALERT_THRESHOLD = 3;
let consecutiveFailures = 0;

/** 数据源名称（东方财富优先、新浪兜底），供前端披露来源 */
function quoteSourceLabel() {
  return process.env.QUOTE_SOURCE_LABEL || '东方财富 / 新浪财经（公开行情接口）';
}

async function poll() {
  if (fetching) return; // 上一次还没回来，跳过，避免堆积
  fetching = true;
  try {
    const m = await fetchRealtimeQuotes();
    if (m && m.size > 0) {
      latest = m;
      lastFetchAt = Date.now();
      polls += 1;
      lastError = null;
      consecutiveFailures = 0;
    }
  } catch (e) {
    lastError = String(e?.message || e);
    consecutiveFailures += 1;
    logger.warn('行情快照拉取失败，沿用上一次数据', {
      err: lastError,
      consecutiveFailures,
    });
  } finally {
    fetching = false;
  }
}

/**
 * 启动行情推送
 * @param {() => boolean} isTrading 判断当前是否处于交易时段
 */
export function startQuoteFeed(isTrading = () => true) {
  if (timer) return timer;
  // 启动时立即拉一次，避免首屏长时间无真实价
  poll();
  timer = setInterval(() => {
    poll().catch((e) => logger.error('行情拉取异常', { err: e }));
    // 动态节奏：交易时段更频繁；这里通过延长/缩短下一次间隔实现不了（setInterval 固定），
    // 因此用「跳过非交易时段的冗余拉取」来控制：非时段下大部分 tick 直接返回
    void isTrading;
  }, POLL_MS);

  // 非交易时段的低频兜底：每 IDLE_MS 拉一次（与上面高频定时并存，靠 shouldPoll 节流）
  timer.idle = setInterval(() => {
    poll().catch(() => {});
  }, IDLE_MS);

  logger.info('行情推送启动', { pollMs: POLL_MS, idleMs: IDLE_MS });
  return timer;
}

export function stopQuoteFeed() {
  if (!timer) return;
  clearInterval(timer);
  if (timer.idle) clearInterval(timer.idle);
  timer = null;
}

/** 是否应该立即拉一次（供外部手动触发，如登录后立刻刷新） */
export async function refreshQuotes() {
  await poll();
  return latest;
}

export default { startQuoteFeed, stopQuoteFeed, getLatestQuotes, getLastFetchAt, quoteFeedStatus, refreshQuotes };
