import pool from './db.js';
import { logger } from './logger.js';

const TICK_MS = Number(process.env.TICK_MS || 2000);
const MAX_HISTORY = 240; // 内存中保留的行情点数
const DAILY_LIMIT = 0.10; // A 股 ±10% 涨跌停限制

const state = new Map(); // code -> stock object
let broadcaster = null;

export function setBroadcaster(fn) {
  broadcaster = fn;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Box-Muller 正态分布随机
function randn() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export async function loadMarket() {
  const { rows } = await pool.query('SELECT * FROM stocks ORDER BY code');
  const points = 120;
  const now = Date.now();
  for (const r of rows) {
    const prevClose = Number(r.prev_close);
    const startP = prevClose;
    const hist = [{ t: now - points * TICK_MS, p: startP }];
    let p = startP;
    const drift = 0.0001;
    const vol = 0.0016;
    for (let i = 1; i < points; i++) {
      p = p * (1 + drift + vol * randn());
      hist.push({ t: now - (points - i) * TICK_MS, p: round2(p) });
    }
    let high = -Infinity;
    let low = Infinity;
    for (const h of hist) {
      if (h.p > high) high = h.p;
      if (h.p < low) low = h.p;
    }
    state.set(r.code, {
      code: r.code,
      name: r.name,
      sector: r.sector,
      prevClose,
      open: startP,
      price: hist[hist.length - 1].p,
      high: round2(Math.max(high, prevClose)),
      low: round2(Math.min(low, prevClose)),
      volume: Number(r.volume),
      history: hist,
    });
  }
  logger.info('行情加载完成', { stocks: state.size });
}

export function tick() {
  const updates = [];
  const now = Date.now();
  for (const s of state.values()) {
    const vol = 0.0019;
    const drift = (Math.random() - 0.5) * 0.0004;
    let np = s.price * (1 + drift + vol * randn());
    const lo = s.prevClose * (1 - DAILY_LIMIT);
    const hi = s.prevClose * (1 + DAILY_LIMIT);
    np = Math.min(hi, Math.max(lo, np));
    np = round2(np);
    s.price = np;
    if (np > s.high) s.high = np;
    if (np < s.low) s.low = np;
    s.volume += Math.floor(Math.random() * 60000) + 2000;
    s.history.push({ t: now, p: np });
    if (s.history.length > MAX_HISTORY) s.history.shift();
    updates.push({ code: s.code, price: s.price, high: s.high, low: s.low, volume: s.volume });
  }
  persist(updates).catch((e) => logger.error('行情落库失败', { err: e }));
  if (broadcaster) broadcaster(updates, now);
}

async function persist(updates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        'UPDATE stocks SET price=$1, high=$2, low=$3, volume=$4, updated_at=now() WHERE code=$5',
        [u.price, u.high, u.low, u.volume, u.code]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function quoteOf(s) {
  return {
    code: s.code,
    name: s.name,
    sector: s.sector,
    prevClose: s.prevClose,
    open: s.open,
    price: s.price,
    high: s.high,
    low: s.low,
    volume: s.volume,
    change: round2(s.price - s.prevClose),
    changePct: round2(((s.price - s.prevClose) / s.prevClose) * 100),
  };
}

export function getSnapshot() {
  const arr = [];
  for (const s of state.values()) arr.push(quoteOf(s));
  return arr;
}

export function getDetail(code) {
  const s = state.get(code);
  if (!s) return null;
  return { ...quoteOf(s), history: s.history };
}

export function getSummary() {
  let up = 0;
  let down = 0;
  let flat = 0;
  let idx = 0;
  let base = 0;
  for (const s of state.values()) {
    const ch = s.price - s.prevClose;
    if (ch > 0) up += 1;
    else if (ch < 0) down += 1;
    else flat += 1;
    idx += s.price;
    base += s.prevClose;
  }
  const total = state.size || 1;
  return {
    up,
    down,
    flat,
    total: state.size,
    indexValue: round2(idx / total),
    indexPct: base ? round2(((idx - base) / base) * 100) : 0,
  };
}

export function startMarket() {
  // 用 try/catch 包住，单次 tick 异常不会中断整个定时器
  setInterval(() => {
    try {
      tick();
    } catch (e) {
      logger.error('行情 tick 执行异常', { err: e });
    }
  }, TICK_MS);
  logger.info('行情引擎启动', { tickMs: TICK_MS, stocks: state.size });
}
