import fs from 'node:fs';
import path from 'node:path';

/**
 * 零依赖结构化日志模块
 * - 分级：debug / info / warn / error
 * - 输出：logs/app-YYYY-MM-DD.log（全量）+ logs/error-YYYY-MM-DD.log（仅错误）
 * - 格式：每行一个 JSON（便于检索与采集），控制台同步输出彩色可读格式
 * - 轮转：按天切分 + 单文件超过阈值自动 .1/.2 轮转 + 过期文件清理
 */

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const MAX_FILE_SIZE = Number(process.env.LOG_MAX_SIZE || 10 * 1024 * 1024); // 默认 10MB
const MAX_ROTATED = Number(process.env.LOG_MAX_ROTATED || 5);
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 14);

fs.mkdirSync(LOG_DIR, { recursive: true });

const COLORS = { DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
const RESET = '\x1b[0m';
const SKIP_KEYS = new Set(['ts', 'level', 'msg']);

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(d = new Date()) {
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function filePath(base) {
  return path.join(LOG_DIR, `${base}-${dayKey()}.log`);
}

// 单文件超阈值则轮转：x.log -> x.log.1，旧的依次后移，超出保留份数丢弃
function rotate(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_FILE_SIZE) return;
  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (fs.existsSync(from)) {
      try {
        fs.renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

function append(file, line) {
  try {
    rotate(file);
    fs.appendFileSync(file, `${line}\n`);
  } catch (e) {
    console.error('[logger] 写日志文件失败:', file, e.message);
  }
}

// 启动时清理超过保留天数的历史日志
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && st.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function serializeError(e) {
  if (!e) return undefined;
  if (!(e instanceof Error)) return { message: String(e) };
  const out = { name: e.name, message: e.message };
  if (e.code !== undefined) out.code = e.code;
  if (e.stack) out.stack = e.stack;
  return out;
}

function emit(level, msg, meta) {
  const num = LEVELS[level] ?? LEVELS.info;
  if (num < MIN_LEVEL) return;

  const entry = { ts: new Date().toISOString(), level: level.toUpperCase(), msg };
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null) continue;
      entry[k] = k === 'err' || v instanceof Error ? serializeError(v) : v;
    }
  }

  const line = JSON.stringify(entry);
  append(filePath('app'), line);
  if (level === 'error') append(filePath('error'), line);

  const extra = Object.keys(entry).filter((k) => !SKIP_KEYS.has(k));
  const suffix = extra.length
    ? ` ${JSON.stringify(Object.fromEntries(extra.map((k) => [k, entry[k]])))}}`
    : '';
  console.log(`${stamp()} ${COLORS[entry.level] || ''}[${entry.level}]${RESET} ${msg}${suffix}`);
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  dir: LOG_DIR,
};

export function installProcessGuards() {
  // 未捕获异常：记录后退出，交由容器 restart 策略自动拉起
  process.on('uncaughtException', (err) => {
    logger.error('进程未捕获异常(uncaughtException)', { err });
    process.exit(1);
  });
  // 未处理的 Promise 拒绝：记录但保持服务可用
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝(unhandledRejection)', { err: reason });
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.info(`收到 ${sig} 信号，服务准备退出`);
      process.exit(0);
    });
  }
}

pruneOldLogs();

export default logger;
