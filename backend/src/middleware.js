import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

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

function clientIp(req) {
  // index.js 已 app.set('trust proxy', 1)，Express 会按「受信任跳数」从 X-Forwarded-For
  // 右侧回推出真实客户端 IP；直接取列表首位会把伪造报文的前缀当成来源。
  return req.ip || req.socket?.remoteAddress || 'unknown';
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
    logger.warn('请求报文非法(4xx)', meta);
    if (res.headersSent) return next(err);
    return res.status(clientStatus).json({
      error: clientStatus === 413 ? '请求体过大' : '请求报文格式错误',
      requestId: req.id,
    });
  }

  logger.error('请求未捕获异常', meta);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误', requestId: req.id });
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
