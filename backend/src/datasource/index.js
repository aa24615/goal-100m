/**
 * 行情数据源统一入口：东方财富优先，新浪兜底
 *
 * 为什么需要兜底：
 *  实测东方财富 push2 系列（clist 列表/实时快照）在高频请求后会对来源 IP 限流，
 *  表现为 TLS 连接被立即关闭（fetch failed），且短时间不恢复；
 *  而 push2his（K 线）通常仍可用。为保证「同步不中断」，做双源 + 熔断。
 *
 * 能力差异：
 *  - 东方财富：含行业(sector)与总市值 -> 可算股本，用于市值加权指数
 *  - 新浪：不含行业（sector 置为「其他」），但含总市值(mktcap)，同样可算股本
 */

import * as em from './eastmoney.js';
import * as sina from './sina.js';

// 简易熔断：连续失败达到阈值后，本进程内暂停尝试该源，避免每次都白等重试；
// 超过冷却时间后允许再探一次（源可能已恢复），实现「自动恢复」
const breaker = { emList: 0, emKline: 0, emRealtime: 0 };
const lastFailAt = { emList: 0, emKline: 0, emRealtime: 0 };
const THRESHOLD = 15;
const COOLDOWN_MS = 60000;

function down(key) {
  if (breaker[key] < THRESHOLD) return false;
  // 冷却期过后放行一次，给源一个恢复机会
  if (Date.now() - lastFailAt[key] > COOLDOWN_MS) {
    breaker[key] = 0;
    return false;
  }
  return true;
}
function ok(key) {
  breaker[key] = 0;
}
function bad(key) {
  breaker[key] += 1;
  lastFailAt[key] = Date.now();
}

/** 全 A 股标的列表 */
export async function fetchAllStocks() {
  if (!down('emList')) {
    try {
      const r = await em.fetchAllStocks();
      if (r.length >= 1000) {
        ok('emList');
        console.log('[数据源] 标的列表 <- 东方财富（含行业）');
        return r;
      }
    } catch (e) {
      bad('emList');
      console.warn(`[数据源] 东方财富列表不可用（${e.message}），切换新浪`);
    }
  }
  const r = await sina.fetchAllStocks();
  console.log(`[数据源] 标的列表 <- 新浪（${r.length} 只，行业字段不可用）`);
  return r.map((s) => ({ ...s, sector: s.sector || '其他' }));
}

/** 单只股票日线：东财 K 线优先（全量），失败回落新浪（约 1023 根上限） */
export async function fetchDailyBars(code) {
  if (!down('emKline')) {
    try {
      const b = await em.fetchDailyBars(code);
      if (b.length > 0) {
        ok('emKline');
        return b;
      }
      return b; // 确实无数据的标的，不再打扰新浪
    } catch (e) {
      bad('emKline');
    }
  }
  try {
    return await sina.fetchDailyBars(code);
  } catch {
    return [];
  }
}

/** 全市场实时快照 */
export async function fetchRealtimeQuotes() {
  if (!down('emRealtime')) {
    try {
      const m = await em.fetchRealtimeQuotes();
      if (m.size >= 1000) {
        ok('emRealtime');
        return m;
      }
    } catch (e) {
      bad('emRealtime');
    }
  }
  return sina.fetchRealtimeQuotes();
}

/** 当前可用源（用于日志/状态展示） */
export function sourceStatus() {
  return {
    eastmoneyList: !down('emList'),
    eastmoneyKline: !down('emKline'),
    eastmoneyRealtime: !down('emRealtime'),
  };
}

export default { fetchAllStocks, fetchDailyBars, fetchRealtimeQuotes, sourceStatus };
