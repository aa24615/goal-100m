import express from 'express';
import http from 'http';
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
import { matchOrders } from './orders.js';
import { loadMarket, startMarket, setBroadcaster, getSnapshot, onTick } from './market.js';
import { seedStocks } from './seed.js';
import { startSnapshots } from './snapshots.js';
import { runMigrations } from './migrate.js';
import { logger, installProcessGuards, onShutdown } from './logger.js';
import { requestLogger, notFoundHandler, errorHandler } from './middleware.js';

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

  wss.on('connection', (ws, req) => {
    // WebSocket 鉴权：token 通过 query 传入（?token=xxx）
    if (WS_AUTH) {
      const url = new URL(req.url, 'http://localhost');
      const uid = verifyToken(url.searchParams.get('token'));
      if (!uid) {
        logger.warn('WebSocket 鉴权失败，拒绝连接', { ip: req.socket?.remoteAddress });
        ws.close(4001, 'unauthorized');
        return;
      }
      ws.userId = uid;
    }
    logger.info('WebSocket 客户端连接', {
      ip: req.socket?.remoteAddress,
      userId: ws.userId ?? null,
      total: wss.clients.size,
    });
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.send(JSON.stringify({ type: 'snapshot', stocks: getSnapshot() }));
    ws.on('error', (e) => logger.error('WebSocket 连接异常', { err: e }));
    ws.on('close', () => logger.info('WebSocket 客户端断开', { total: wss.clients.size }));
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
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    logger.error('服务启动失败(fatal)', { err: e });
    process.exit(1);
  });
}

export default app;
