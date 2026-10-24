import express from 'express';
import http from 'http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import pool from './db.js';
import authRoutes, { verifyToken } from './auth.js';
import marketRoutes from './routes/market.js';
import tradeRoutes from './routes/trade.js';
import leaderboardRoutes from './routes/leaderboard.js';
import equityRoutes from './routes/equity.js';
import configRoutes from './routes/config.js';
import watchlistRoutes from './routes/watchlist.js';
import orderRoutes from './routes/orders.js';
import replayRoutes from './routes/replay.js';
import reviewRoutes from './routes/review.js';
import onboardingRoutes from './routes/onboarding.js';
import scenarioRoutes from './routes/scenario.js';
import roomRoutes from './routes/rooms.js';
import analyticsRoutes from './routes/analytics.js';
import { matchOrders } from './orders.js';
import { loadMarket, startMarket, setBroadcaster, getSnapshot, onTick } from './market.js';
import { seedStocks } from './seed.js';
import { seedScenarios } from './services/scenarioService.js';
import { startSnapshots } from './snapshots.js';
import { runMigrations } from './migrate.js';
import { logger, installProcessGuards, onShutdown } from './logger.js';
import { requestLogger, notFoundHandler, errorHandler, proxyClientIp } from './middleware.js';

installProcessGuards();

/**
 * 构建并配置 Express 应用（不含 HTTP server / WebSocket / 进程监听）。
 * 抽离出来便于集成测试以 app.listen(0) 起临时服务做真实 HTTP 验证。
 */
export function createApp() {
  const app = express();
  // 服务运行在 nginx 之后：信任最后 1 跳，使 req.ip 还原为真实客户端 IP
  // （不能设 true，否则 X-Forwarded-For 首位可被伪造）
  app.set('trust proxy', 1);

  // CORS 白名单：未配置 ALLOWED_ORIGINS 时允许同源/无 Origin 请求
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
          return cb(null, true);
        }
        logger.warn('CORS 拒绝来源', { origin });
        return cb(new Error('不允许的跨域来源'));
      },
    })
  );
  app.use(express.json());
  app.use(requestLogger);

  // 限流：注册/登录按 IP 限制，交易接口按用户更频繁但仍有上限
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '尝试过于频繁，请稍后再试' },
  });
  const tradeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.TRADE_RATE_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '交易请求过于频繁，请稍后再试' },
  });
  app.use('/api/register', authLimiter);
  app.use('/api/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/login', authLimiter);
  // 密码找回同样受登录级限流保护，防止被滥用于邮件轰炸（RQ-30 防滥用）
  app.use('/api/auth/forgot', authLimiter);
  app.use('/api/auth/reset', authLimiter);
  app.use('/api/trade', tradeLimiter);

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api', authRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api', marketRoutes);
  app.use('/api', tradeRoutes);
  app.use('/api', leaderboardRoutes);
  app.use('/api', equityRoutes);
  app.use('/api', configRoutes);
  app.use('/api', watchlistRoutes);
  app.use('/api', orderRoutes);
  app.use('/api', replayRoutes);
  app.use('/api', reviewRoutes);
  app.use('/api', onboardingRoutes);
  app.use('/api', scenarioRoutes);
  app.use('/api', roomRoutes);
  app.use('/api', analyticsRoutes);

  // 兜底中间件必须放在所有路由之后：记录 404 与未捕获异常
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();

// HTTP server + WebSocket：仅在进程作为入口直接运行时启用
function startServer() {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const WS_AUTH = process.env.WS_AUTH !== '0'; // 默认开启 WebSocket 鉴权

  function broadcast(updates, now) {
    const msg = JSON.stringify({ type: 'tick', time: now, stocks: updates });
    let sent = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === 1) {
        ws.send(msg);
        sent += 1;
      }
    }
    if (sent > 0) logger.debug('行情推送', { clients: sent, stocks: updates.length });
  }
  setBroadcaster(broadcast);

  // 鉴权失败日志节流：同一 IP 在窗口内最多记录 WS_AUTH_LOG_MAX 条，
  // 超出后静默，窗口结束时补一条汇总（含被抑制计数）。
  const WS_AUTH_LOG_WINDOW_MS = 60_000;
  const WS_AUTH_LOG_MAX = 3;
  const wsAuthSeen = new Map(); // ip -> { count, suppressed, windowStart }

  function wsAuthLogGate(ip) {
    const now = Date.now();
    const rec = wsAuthSeen.get(ip);
    if (!rec || now - rec.windowStart >= WS_AUTH_LOG_WINDOW_MS) {
      if (rec && rec.suppressed > 0) {
        logger.warn('WebSocket 鉴权失败(汇总)', {
          ip,
          suppressed: rec.suppressed,
          windowMs: WS_AUTH_LOG_WINDOW_MS,
        });
      }
      wsAuthSeen.set(ip, { count: 1, suppressed: 0, windowStart: now });
      return true;
    }
    rec.count += 1;
    if (rec.count <= WS_AUTH_LOG_MAX) return true;
    rec.suppressed += 1;
    return false;
  }

  // 单账号并发连接上限：2026-10-23 实测同一用户（userId=21）在 30 秒内累积出 8 条常连接，
  // 且全天 56 次连接只对应 40 次断开（净泄漏 16 条）。客户端泄漏或异常重连会让
  // wss.clients 无上限增长，而每次 tick 都要向全部连接广播全市场快照，连接数直接放大广播成本。
  // 超出上限时关闭该用户「最旧」的几条，保证最近打开的页面可用。
  const WS_MAX_PER_USER = Number(process.env.WS_MAX_PER_USER || 3);
  const connOpenedAt = new WeakMap(); // ws -> 建立时间戳

  function enforceConnLimit(uid) {
    if (typeof uid !== 'number') return; // 未鉴权连接（WS_AUTH=0）不参与限制
    const mine = [];
    for (const c of wss.clients) if (c.userId === uid) mine.push(c);
    if (mine.length <= WS_MAX_PER_USER) return;
    mine.sort((a, b) => (connOpenedAt.get(a) || 0) - (connOpenedAt.get(b) || 0));
    // 当前连接是最新建立的，排序后必在末尾，不会被自己淘汰
    for (const victim of mine.slice(0, mine.length - WS_MAX_PER_USER)) {
      try {
        victim.close(4002, 'connection limit');
      } catch {
        /* ignore */
      }
    }
  }

  // 防止 Map 随 IP 增长而泄漏：每次连接建立时惰性清理过期条目
  function gcWsAuthSeen() {
    const now = Date.now();
    for (const [k, v] of wsAuthSeen) {
      if (now - v.windowStart >= WS_AUTH_LOG_WINDOW_MS * 2) wsAuthSeen.delete(k);
    }
  }

  wss.on('connection', (ws, req) => {
    gcWsAuthSeen();
    const ip = proxyClientIp(req);
    // WebSocket 鉴权：token 通过 query 传入（?token=xxx）
    if (WS_AUTH) {
      const url = new URL(req.url, 'http://localhost');
      const uid = verifyToken(url.searchParams.get('token'));
      if (!uid) {
        // 客户端重连风暴会把同一条失败日志放大上万倍（2026-10-21 曾产生 8604 条），
        // 按 IP 节流：窗口内只记前 N 条，末尾汇总一次被抑制的数量
        if (wsAuthLogGate(ip)) {
          logger.warn('WebSocket 鉴权失败，拒绝连接', { ip });
        }
        ws.close(4001, 'unauthorized');
        return;
      }
      ws.userId = uid;
    }
    connOpenedAt.set(ws, Date.now());
    enforceConnLimit(ws.userId);
    logger.info('WebSocket 客户端连接', {
      ip,
      userId: ws.userId ?? null,
      total: wss.clients.size,
    });
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.send(JSON.stringify({ type: 'snapshot', stocks: getSnapshot() }));
    ws.on('error', (e) => logger.error('WebSocket 连接异常', { err: e }));
    ws.on('close', (code, reason) => {
      // 补 close code / reason / 存活时长：此前只有 total，无法判断连接是客户端正常关闭、
      // 被限流淘汰（4002）、鉴权拒绝（4001）还是心跳超时被 terminate，排障全靠猜。
      logger.info('WebSocket 客户端断开', {
        ip,
        userId: ws.userId ?? null,
        code: code ?? null,
        reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason || ''),
        ms: Date.now() - (connOpenedAt.get(ws) ?? Date.now()),
        total: wss.clients.size,
      });
    });
  });
  wss.on('error', (e) => logger.error('WebSocket 服务异常', { err: e }));

  // 心跳：30 秒 ping 一次，两轮未 pong 则主动断开，避免死连接堆积
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30000);

  // 优雅关闭：停止心跳 → 关闭 WS → 关闭 HTTP → 释放数据库连接池
  onShutdown(async () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => {
      try {
        wss.close(r);
      } catch {
        r();
      }
    });
    await new Promise((r) => server.close(r));
    await pool.end().catch(() => {});
    logger.info('优雅关闭完成，资源已释放');
  });

  return server;
}

async function waitForDb() {
  let ok = false;
  let attempt = 0;
  while (!ok) {
    try {
      await pool.query('SELECT 1');
      ok = true;
    } catch (e) {
      attempt += 1;
      logger.warn('数据库连接失败，等待重试', { attempt, err: e.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  logger.info('后端服务启动中', { node: process.version, pid: process.pid, logDir: logger.dir });
  await waitForDb();
  logger.info('数据库连接成功');
  await runMigrations(pool);
  await seedStocks();
  await seedScenarios(); // 剧本题库：固定 8 关，启动即就绪（RQ-16）
  await loadMarket();
  startSnapshots();
  // 每个行情 tick 之后尝试撮合限价委托
  onTick(() => matchOrders());
  const server = startServer();
  startMarket();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    logger.info(`服务已监听端口 ${PORT}`);
  });
}

// 仅当作为入口直接运行时启动（集成测试 import 本模块时不启动服务）
//
// 原先写成 `import.meta.url === `file://${process.argv[1]}``：
// Linux 下二者一致，但 Windows 下 import.meta.url 是 file:///D:/xxx（三斜杠 + 正斜杠），
// 而模板串拼出的是 file://D:\xxx（两斜杠 + 反斜杠），永不相等 ——
// 直接 `node src/index.js` 会静默退出且没有任何日志，看起来像「启动即崩」。
// 统一转成真实文件系统路径再比较，跨平台一致。
const isDirectEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  main().catch((e) => {
    logger.error('服务启动失败(fatal)', { err: e });
    process.exit(1);
  });
}

export default app;
