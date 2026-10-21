import type { StockQuote } from './types';

type Listener = (quotes: StockQuote[], tickTime?: number) => void;

let ws: WebSocket | null = null;
const prices = new Map<string, StockQuote>();
const listeners = new Set<Listener>();
let reconnectTimer: number | null = null;
let pingTimer: number | null = null;
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
    if (reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    }
  };

  ws.onerror = () => {
    ws?.close();
  };
}

connect();

// 登录/登出后需要重建带新 token 的连接
export function reconnect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  connect();
}
