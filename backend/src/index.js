import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import pool from './db.js';
import authRoutes from './auth.js';
import marketRoutes from './routes/market.js';
import tradeRoutes from './routes/trade.js';
import leaderboardRoutes from './routes/leaderboard.js';
import { loadMarket, startMarket, setBroadcaster, getSnapshot } from './market.js';
import { seedStocks } from './seed.js';
import { ensureSnapshotTable, startSnapshots } from './snapshots.js';
import { logger, installProcessGuards } from './logger.js';
import { requestLogger, notFoundHandler, errorHandler } from './middleware.js';

installProcessGuards();

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api', authRoutes);
app.use('/api/auth', authRoutes);
app.use('/api', marketRoutes);
app.use('/api', tradeRoutes);
app.use('/api', leaderboardRoutes);

// 兜底中间件必须放在所有路由之后：记录 404 与未捕获异常
app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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
  logger.info('WebSocket 客户端连接', { ip: req.socket?.remoteAddress, total: wss.clients.size });
  ws.send(JSON.stringify({ type: 'snapshot', stocks: getSnapshot() }));
  ws.on('error', (e) => logger.error('WebSocket 连接异常', { err: e }));
  ws.on('close', () => logger.info('WebSocket 客户端断开', { total: wss.clients.size }));
});
wss.on('error', (e) => logger.error('WebSocket 服务异常', { err: e }));

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
  await seedStocks();
  await loadMarket();
  await ensureSnapshotTable();
  startSnapshots();
  startMarket();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    logger.info(`服务已监听端口 ${PORT}`);
  });
}

main().catch((e) => {
  logger.error('服务启动失败(fatal)', { err: e });
  process.exit(1);
});
