import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { INT32_MAX } from './utils/num.js';

/**
 * HTTP 层日志中间件
 * - requestLogger：为每个请求生成 requestId，响应结束时记录方法/路径/状态码/耗时/IP/UA/用户
 *   5xx -> error，4xx -> warn（附带脱敏后的请求体），其余 -> info
 * - notFoundHandler：记录未匹配路由的 404
 * - errorHandler：兜底记录异常堆栈；请求报文非法(4xx)按 warn 记录并回对应状态码，
 *   其余未捕获异常才记 error 并返回统一 500
 * - asyncHandler：包装异步路由（Express 4 不会自动捕获 async 抛错）
 */

const SENSITIVE = /pass|token|secret|authorization|cookie|hash/i;

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '***' : v && typeof v === 'object' ? redact(v) : v;
  }
  return out;
}

// index.js 已 app.set('trust proxy', 1)，Express 会按「受信任跳数」从 X-Forwarded-For
// 右侧回推出真实客户端 IP；直接取列表首位会把伪造报文的前缀当成来源。
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// 受信任的反向代理跳数，必须与 index.js 的 app.set('trust proxy', N) 保持一致
export const TRUST_PROXY_HOPS = 1;

/**
 * 为「未经 Express 中间件」的请求解析客户端 IP（如 WebSocket upgrade）。
 *
 * 背景：WebSocketServer 直接挂在原生 http.Server 上，upgrade 回调里的 req 是
 * 原生 IncomingMessage —— 没有经过 Express，app.set('trust proxy') 不生效、
 * req.ip 恒为 undefined。此前直接取 req.socket.remoteAddress，拿到的永远是
 * nginx 容器地址（日志中 8600+ 条 WebSocket 鉴权失败记录的 ip 全为
 * ::ffff:192.168.96.4），完全丧失追溯能力。
 *
 * 算法与 Express/proxy-addr 的 trust proxy = N 完全等价：
 * XFF 列表自左(客户端)向右(最近一跳代理)排列，取 index = min(len - 1, N)。
 * 这样 HTTP 与 WebSocket 两条链路的安全语义一致，不会被伪造前缀欺骗。
 */
export function proxyClientIp(req, hops = TRUST_PROXY_HOPS) {
  const raw = req?.headers?.['x-forwarded-for'];
  if (typeof raw === 'string' && raw.trim()) {
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list[Math.min(list.length - 1, hops)];
  }
  // 无 XFF：说明反向代理未转发该头，退化为直连对端地址
  return req?.socket?.remoteAddress || 'unknown';
}

export function requestLogger(req, res, next) {
  req.id = randomUUID().slice(0, 8);
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
    const meta = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      query: req.originalUrl?.includes('?') ? req.originalUrl.split('?')[1] : undefined,
      status: res.statusCode,
      ms,
      ip: clientIp(req),
      userId: req.userId,
    };
    if (process.env.LOG_UA === '1') meta.ua = req.headers['user-agent'];

    if (res.statusCode >= 500) {
      meta.body = redact(req.body);
      logger.error('请求处理失败(5xx)', meta);
    } else if (res.statusCode >= 400) {
      meta.body = redact(req.body);
      logger.warn('请求被拒绝(4xx)', meta);
    } else {
      logger.info('请求完成', meta);
    }
  });

  next();
}

export function notFoundHandler(req, res) {
  logger.warn('接口不存在(404)', {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    ip: clientIp(req),
  });
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` });
}

// body-parser / 请求体校验类失败会带 status(400/413/415)，这属于「客户端错误」，
// 不能按服务端故障返回 500、更不能记 ERROR，否则会污染告警并掩盖真实的服务端异常
function clientErrorStatus(err) {
  const s = Number(err?.status || err?.statusCode);
  return Number.isInteger(s) && s >= 400 && s < 500 ? s : 0;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const clientStatus = clientErrorStatus(err);
  // 请求体解析失败时 req.body 为空对象，补记错误类型便于回溯是哪个解析环节失败
  const meta = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    ip: clientIp(req),
    userId: req.userId,
    body: redact(req.body),
    err,
  };
  if (err?.type) meta.errType = err.type;

  if (clientStatus) {
    // 区分「业务规则拒绝」与「请求报文非法」：
    // 后者是 body-parser/413/415 等报文层面的失败，说明客户端打错了；
    // 前者是入参合法但未通过业务校验（T+1 冻结、资金不足、邀请码无效…），属于正常业务路径。
    // 混用同一文案会让 4xx 告警失去可行动性——2026-10-22 的 248 条
    // 「请求报文非法」里约 240 条其实是业务规则拒绝。
    logger.warn(err?.business ? '业务规则拒绝(4xx)' : '请求报文非法(4xx)', meta);
    if (res.headersSent) return next(err);
    const msg = err?.expose
      ? err.message
      : clientStatus === 413
      ? '请求体过大'
      : '请求报文格式错误';
    const body = { error: msg, requestId: req.id };
    if (err?.expose && err.extra) Object.assign(body, err.extra);
    return res.status(clientStatus).json(body);
  }

  logger.error('请求未捕获异常', meta);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误', requestId: req.id });
}

/**
 * 构造「业务错误」：带 HTTP 状态码且允许把 message 透传给前端。
 * 统一在此构造，避免各 service 各自造轮子导致 expose 语义不一致。
 */
export function businessError(message, status = 400, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra || {};
  e.expose = true;
  e.business = true; // 标记为业务规则拒绝，区别于报文解析失败
  return e;
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 解析路径参数里的正整数 ID，非法输入返回 null。
 *
 * 背景：直接 `Number(req.params.id)` 时，`/api/orders/abc` 会得到 NaN，
 * pg 把它序列化成字面量 'NaN' 发给 PostgreSQL，数据库解析 integer 列时抛
 * 22P02（invalid input syntax for type integer），最终被 errorHandler 兜底成
 * **500 + 一条 ERROR 日志**。也就是说「用户随便填个路径」就能制造服务端错误告警，
 * 污染 5xx 指标并掩盖真实故障。这里统一拦成 400。
 *
 * 为什么用 isSafeInteger 而不是 isInteger：
 * `Number.isInteger()` 只判断「数学上是整数」，不做范围约束。`'99999999999999999999'`
 * 会被解析成 1e20，它是整数且大于 0，于是顺利通过旧校验；但 1e20 远超 PostgreSQL
 * bigint 的上限 9223372036854775807，下发 SQL 后数据库抛
 * **22003（value "100000000000000000000" is out of range for type bigint）**，
 * 同样被兜成 500。实测 `GET /api/replay/99999999999999999999` 与
 * `GET /api/blind/99999999999999999999` 均稳定复现该 500。
 *
 * 为什么还要额外加上 int4 上界（而不是只做 isSafeInteger）：
 * `Number.isInteger()` 只判断「数学上是整数」，不做范围约束。本库 int4 / int8
 * 混用（同为 ID 列也如此），而 PostgreSQL 拒绝任何超出该列类型的字面量，抛
 * **22003（value "..." is out of range for type integer / bigint）**，最终同样
 * 兜成 500。实测 `/api/replay/compare?startSeq=1e20` 命中的就是 **integer** 列。
 * 因此这里取二者中更严格的 int4 上限 2147483647 —— 它同时满足 int4 与 int8，
 * 一次性消灭整个缺陷类；而真实表的行数远低于此，绝不会误伤合法 ID。
 */
export function parseIdParam(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= INT32_MAX ? n : null;
}
