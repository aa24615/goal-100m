import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

/**
 * HTTP 层日志中间件
 * - requestLogger：为每个请求生成 requestId，响应结束时记录方法/路径/状态码/耗时/IP/UA/用户
 *   5xx -> error，4xx -> warn（附带脱敏后的请求体），其余 -> info
 * - notFoundHandler：记录未匹配路由的 404
 * - errorHandler：兜底记录异常堆栈并返回统一 500
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
  return (
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
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

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  logger.error('请求未捕获异常', {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    ip: clientIp(req),
    userId: req.userId,
    body: redact(req.body),
    err,
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误', requestId: req.id });
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
