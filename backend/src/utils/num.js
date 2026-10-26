// 外部入参收敛工具：把请求里的数值参数安全地夹到受控区间。
// 纯函数、无 DB 依赖，便于单元测试，与 utils/time.js 同属「无副作用工具层」。

/**
 * 把任意输入收敛成 [min, max] 区间内的整数。
 *
 * 背景：此前分页/限流口径散落在各路由与服务里，写法多为只夹一边的
 * `Math.max(1, x)` 或 `Math.min(50, x)` —— 另一边依赖调用方兜底。一旦那条
 * 兜底不存在，负数就会原样进 SQL 的 LIMIT/OFFSET，PostgreSQL 抛 2201W
 * 「LIMIT must not be negative」；而 `?page=1e309` 被 Number 解析成
 * Infinity，抛 22P02「invalid input syntax for type bigint: "Infinity"」。
 * 两者最终都被 errorHandler 兜成 **500 + 一条 ERROR 日志**：用户随手在地址栏
 * 改个查询参数就能制造服务端错误告警，污染 5xx 指标并掩盖真实故障。
 *
 * 本办法（口径与既有 `Number(x) || fallback` 保持一致，不改变合法输入的结果）：
 * - 0 / 空串 / NaN / Infinity / null / undefined 这些「无法当作有效数字」的
 *   输入一律取 fallback —— 与旧写法里 `|| fallback` 的行为一致；
 * - 其余值先向下取整再夹到 [min, max]：负值夹到 min（而不是 fallback），
 *   超界值夹到 max；
 * - 返回值一定是 [min, max] 内的安全整数，可直接下发 SQL。
 */
export function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  const v = Number.isFinite(n) && n !== 0 ? n : fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** 语义化别名：专门用于 SQL LIMIT 的场景，读代码时一眼看出意图 */
export const clampLimit = (raw, max, fallback) => clampInt(raw, 1, max, fallback);
