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

/**
 * PostgreSQL `integer`（int4）列的上限。
 *
 * 本库里 int4 / int8 混用：主键与行情序列表有的是 bigint，有的是 integer。
 * 只要入参可能进其中任意一类列，就只能取二者中更严格的 int4 上限做约束，
 * 才能同时对两类列都安全。
 */
export const INT32_MAX = 2147483647;

/**
 * 判断一个值能否安全地写进 PostgreSQL `integer`（int4）列。
 *
 * 与 `clampInt` 的分工：clampInt 用于「夹取」（分页/限流），本函数用于「判定」
 * （ID / 序号这类必须原样匹配的入参，夹取会查到错误的行，只能拒绝）。
 *
 * 背景：`Number.isInteger()` 只判断「数学上是整数」，不做范围约束。
 * `'99999999999999999999'` 解析成 1e20 后是整数，顺利通过校验，下发 SQL 时
 * PostgreSQL 抛 **22003（value "100000000000000000000" is out of range for
 * type integer / bigint）**，被 errorHandler 兜成 500 + 一条 ERROR 日志。
 * 实测复现：`/api/replay/compare?startSeq=1e20`、`POST /api/challenge/join`
 * 携带 `sessionId=1e20`。
 */
export function isDbInt(v) {
  return Number.isSafeInteger(v) && v >= -INT32_MAX && v <= INT32_MAX;
}

/**
 * PostgreSQL `numeric(p, s)` 列能表示的最大值。
 *
 * 与 int4/int8 越界同理，金额列也有一类容易被忽略的越界：`numeric(18,2)`
 * 最多 16 位整数 + 2 位小数。而代码里的写法往往是 `Number(x) > 0 ? Number(x) : DEFAULT`
 * ——它只判「是不是正数」，不判上界，于是 `1e20`、`Infinity` 这类**数学上合法的正数**
 * 会原样下发 SQL，PostgreSQL 抛 **22003「numeric field overflow」**并被 errorHandler
 * 兜成 500。
 * 实测复现：`POST /api/replay/start` 携带 `capital=1e20`（其余参数合法）。
 */
export const MAX_MONEY_18_2 = 9999999999999999.99; // numeric(18,2)
export const MAX_MONEY_12_2 = 9999999999.99; // numeric(12,2)，用于价格类列

/**
 * 判断一个值能否安全地写进 PostgreSQL `numeric(p, s)` 金额列。
 *
 * 与 `clampInt` 的分工同 `isDbInt`：金额列同样只判正负是不够的，
 * 必须同时是**有限数**——`Infinity` 满足 `> 0` 却无法写入任何 numeric 列。
 */
export function isDbMoney(v, max = MAX_MONEY_18_2) {
  return Number.isFinite(v) && v > 0 && v <= max;
}

/**
 * 金额收敛：合法则原样返回，非法一律回落 fallback。
 *
 * 沿用项目既有的「非法入参回落默认值」口径（与 `Number(x) || fallback`
 * 对 abc/NaN/0/负数的行为一致），保证**合法输入的结果零变化**：
 * 不做四舍五入，精度处理仍交给 PostgreSQL，避免 JS 与 PG 的舍入差异。
 */
export function clampMoney(raw, fallback, max = MAX_MONEY_18_2) {
  const n = Number(raw);
  return isDbMoney(n, max) ? n : fallback;
}
