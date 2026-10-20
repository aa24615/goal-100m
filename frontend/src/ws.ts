import type { StockQuote } from './types';

type Listener = (quotes: StockQuote[]) => void;

let ws: WebSocket | null = null;
const prices = new Map<string, StockQuote>();
const listeners = new Set<Listener>();
let reconnectTimer: number | null = null;

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

function emit() {
  const arr = Array.from(prices.values());
  listeners.forEach((l) => l(arr));
}

function connect() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}/ws`);

  ws.onopen = () => {
    // eslint-disable-next-line no-console
    console.log('[ws] connected');
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'snapshot') {
        prices.clear();
        data.stocks.forEach((s: StockQuote) => prices.set(s.code, s));
        emit();
      } else if (data.type === 'tick') {
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

  ws.onclose = () => {
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
