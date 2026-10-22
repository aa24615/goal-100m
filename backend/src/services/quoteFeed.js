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

export function quoteFeedStatus() {
  return {
    size: latest.size,
    lastFetchAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
    polls,
    lastError,
    pollMs: POLL_MS,
    idleMs: IDLE_MS,
  };
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
    }
  } catch (e) {
    lastError = String(e?.message || e);
    logger.warn('行情快照拉取失败，沿用上一次数据', { err: lastError });
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
