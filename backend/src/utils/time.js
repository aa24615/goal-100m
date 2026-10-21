// 时区与数值工具：集中处理上海时区相关的日期/时间换算，避免各业务模块重复实现。
// 纯函数、无 DB 依赖，便于单元测试，也是前后端时区口径一致的唯一来源。

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 上海时区下的自然日字符串 YYYY-MM-DD（与 UTC 偏移 +8h） */
export function shToday(d = new Date()) {
  return new Date(d.getTime() + 8 * HOUR).toISOString().slice(0, 10);
}

/** 把 pg 返回的 DATE 对象 / 字符串统一转成 'YYYY-MM-DD' 再比较 */
export function dateStrOf(v) {
  if (!v) return '';
  if (v instanceof Date) return new Date(v.getTime() + 8 * HOUR).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const pct2 = (n) => Math.round(n * 100) / 100;

/** 上海时区自然日序号（同一自然日序号相同，跨日 +1），用于按日聚合快照 */
export const shDayIndex = (ms) => Math.floor((ms + 8 * HOUR) / DAY);
export const startOfShDay = (idx) => idx * DAY - 8 * HOUR;
export const dateStr = (idx) => new Date(startOfShDay(idx) + 8 * HOUR).toISOString().slice(0, 10);
/** 当前上海时间 HH:mm（不依赖进程 TZ，容器跑在 UTC 下也不会错位 8 小时） */
export const nowHmStr = () => new Date(Date.now() + 8 * HOUR).toISOString().slice(11, 16);
