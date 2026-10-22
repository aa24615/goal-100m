import type { StockQuote } from './types';

type Listener = (quotes: StockQuote[], tickTime?: number) => void;

let ws: WebSocket | null = null;
const prices = new Map<string, StockQuote>();
const listeners = new Set<Listener>();
let reconnectTimer: number | null = null;
let pingTimer: number | null = null;
// 重连状态：固定 2 秒无条件重连会在服务端异常时形成请求风暴 ——
// 2026-10-21 曾因缺少退避在 7 小时内产生 8604 条「WebSocket 鉴权失败」日志。
// 现改为「指数退避 + 抖动 + 次数上限 + 后台标签页暂停」。
let reconnectAttempts = 0;
let reconnectPaused = false; // 页面隐藏时挂起重连，恢复可见后再继续
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;

function nextReconnectDelay(): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
  // ±30% 抖动：避免多个标签页在同一时刻集体重连形成尖峰
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.round(exp * jitter);
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, nextReconnectDelay());
}

// 页面不可见时不重连（挂着过夜的标签页是历史日志风暴的直接来源），
// 恢复可见时重置退避并立即补一次连接。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!reconnectPaused) return;
    reconnectPaused = false;
    reconnectAttempts = 0;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  });
}
let lastTickTime = Date.now(); // 统一使用服务端 tick 时间，避免两端时钟偏差导致曲线回折
let emitScheduled = false;
let pendingArgs: [StockQuote[], number] | null = null;

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function getPrice(code: string): StockQuote | undefined {
  return prices.get(code);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(Array.from(prices.values()));
  return () => {
    listeners.delete(l);
  };
}

// 高频 tick 合并到下一帧再通知，避免同一帧内多次全量重渲染
function emit() {
  pendingArgs = [Array.from(prices.values()), lastTickTime];
  if (emitScheduled) return;
  emitScheduled = true;
  const flush = () => {
    emitScheduled = false;
    const args = pendingArgs;
    if (!args) return;
    listeners.forEach((l) => l(args[0], args[1]));
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

function connect() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // 携带 token：服务端会校验，未登录的连接会被拒绝（4001）
  const token = localStorage.getItem('pt_token') || '';
  const url = `${proto}://${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    // 连接成功即重置退避计数，避免一次偶发抖动后长期停留在最大间隔
    reconnectAttempts = 0;
    reconnectPaused = false;
    // 客户端心跳：定期发送 ping 文本，配合服务端 ping/pong 保活
    if (pingTimer !== null) window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'snapshot') {
        prices.clear();
        data.stocks.forEach((s: StockQuote) => prices.set(s.code, s));
        emit();
      } else if (data.type === 'tick') {
        // 以服务端 tick 时间为准
        if (typeof data.time === 'number') lastTickTime = data.time;
        data.stocks.forEach((s: { code: string; price: number; high: number; low: number; volume: number }) => {
          const prev = prices.get(s.code);
          if (prev) {
            const up = { ...prev, price: s.price, high: s.high, low: s.low, volume: s.volume };
            up.change = round2(s.price - prev.prevClose);
            up.changePct = round2(((s.price - prev.prevClose) / prev.prevClose) * 100);
            prices.set(s.code, up);
          } else {
            prices.set(s.code, { ...s, prevClose: s.price, open: s.price, change: 0, changePct: 0 } as StockQuote);
          }
        });
        emit();
      }
    } catch (err) {
      // ignore parse errors
    }
  };

  ws.onclose = (e) => {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
    // 4001 = 未授权：清除无效 token，不再重连（交由页面跳登录）
    if (e.code === 4001) {
      localStorage.removeItem('pt_token');
      return;
    }
    // 后台标签页：挂起重连，等页面重新可见时再恢复
    if (typeof document !== 'undefined' && document.hidden) {
      reconnectPaused = true;
      return;
    }
    // 超过上限则停止重连，避免服务端长期不可用时被客户端持续冲击
    if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      reconnectPaused = true;
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

connect();

// 登录/登出后需要重建带新 token 的连接
export function reconnect() {
  // 主动重连视为「已知原因的重建」，重置退避以免沿用上一次的失败计数
  reconnectAttempts = 0;
  reconnectPaused = false;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  connect();
}
