import pool from './db.js';
import { logger } from './logger.js';

/**
 * 行情引擎（重构版）
 * - 引入「交易日」概念：每个交易日由 SESSION_TICKS 个 tick 组成，收盘后结算并进入下一交易日
 * - 收盘结算：写日线、滚动 prev_close、重置 high/low/volume
 * - 隔夜跳空：开盘价 = 昨收 × (1 + gap)，不再是「今开恒等于昨收」
 * - 持久化：日线落 stock_daily，重启后从 DB 恢复，不再重新随机生成导致价格跳变
 * - 成交量：由「基础随机量 + 用户真实成交量」构成，收盘重置
 * - 指数：市值加权基点法，取代等权平均价
 */

const TICK_MS = Number(process.env.TICK_MS || 2000);
const MAX_HISTORY = 240; // 内存中保留的当日分时点数
const DAILY_LIMIT = 0.10; // A 股 ±10% 涨跌停限制
const SESSION_TICKS = Number(process.env.SESSION_TICKS || 120); // 一个交易日的 tick 数
const BREAK_TICKS = Number(process.env.SESSION_BREAK_TICKS || 5); // 收盘后休市的 tick 数
const GAP_SIGMA = Number(process.env.GAP_SIGMA || 0.015); // 隔夜跳空波动率
const INTRADAY_VOL = Number(process.env.INTRADAY_VOL || 0.0012); // 单 tick 波动率
const PERSIST_EVERY = Number(process.env.PERSIST_EVERY_TICKS || 5);
const REAL_CLOCK = process.env.REAL_CLOCK === '1'; // 按真实时钟判断交易时段
const INDEX_BASE = 1000; // 大盘指数基点

const state = new Map(); // code -> stock object
let broadcaster = null;
let tickCount = 0;
const tickHooks = []; // tick 后回调（如限价单撮合）

/** 注册每次 tick 之后的钩子 */
export function onTick(fn) {
  tickHooks.push(fn);
}

// 交易日历状态（持久化在 market_meta）
let meta = {
  seq: 1, // 交易日序号
  sessionTick: 0,
  phase: 'TRADING', // TRADING | BREAK | CLOSED
  breakLeft: 0,
  tradeDate: shToday(),
};

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

function shToday(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 代码稳定散列，用于生成股本（保证每次运行一致）
export function hashOf(code) {
  let h = 0;
  for (let i = 0; i < code.length; i += 1) h = (h * 31 + code.charCodeAt(i)) % 100003;
  return h % 1000;
}

export function sharesOf(code, prevClose) {
  const marketCap = 8e9 + (hashOf(code) / 1000) * 2.9e10; // 80 亿 ~ 370 亿市值
  return Math.round(marketCap / prevClose / 1e4) * 1e4; // 取整到万股
}

// 股本回填：seed 阶段若未写入 shares，则按市值估算补全（仅数据，不涉及表结构）
export async function backfillStockShares() {
  const r = await pool.query('SELECT code, price, prev_close, shares FROM stocks');
  for (const row of r.rows) {
    if (row.shares) continue;
    const shares = sharesOf(row.code, Number(row.prev_close || row.price || 10));
    await pool.query('UPDATE stocks SET shares=$1 WHERE code=$2', [shares, row.code]);
  }
}

async function loadMeta() {
  const { rows } = await pool.query('SELECT k, v FROM market_meta');
  const m = {};
  for (const r of rows) m[r.k] = r.v;
  if (m.trade_seq) meta.seq = Number(m.trade_seq);
  if (m.session_tick) meta.sessionTick = Number(m.session_tick);
  if (m.phase) meta.phase = m.phase;
  if (m.break_left) meta.breakLeft = Number(m.break_left);
  if (m.trade_date) meta.tradeDate = m.trade_date;
}

async function saveMeta() {
  const kv = [
    ['trade_seq', String(meta.seq)],
    ['session_tick', String(meta.sessionTick)],
    ['phase', meta.phase],
    ['break_left', String(meta.breakLeft)],
    ['trade_date', meta.tradeDate],
  ];
  await pool.query(
    `INSERT INTO market_meta (k, v) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [kv.map((x) => x[0]), kv.map((x) => x[1])]
  );
}

// ---------- 加载：从 DB 恢复，不重新随机生成 ----------
export async function loadMarket() {
  await backfillStockShares();
  await loadMeta();

  const { rows } = await pool.query('SELECT * FROM stocks ORDER BY code');
  const daily = await pool.query(
    'SELECT * FROM stock_daily WHERE seq = $1',
    [meta.seq]
  );
  const dmap = new Map(daily.rows.map((r) => [r.code, r]));
  const now = Date.now();

  for (const r of rows) {
    const prevClose = Number(r.prev_close);
    const d = dmap.get(r.code);
    let open;
    let price;
    let high;
    let low;
    let volume;
    let amount;

    if (d) {
      // 当日已有日线：恢复到收盘/最新状态
      open = Number(d.open);
      price = Number(d.close);
      high = Number(d.high);
      low = Number(d.low);
      volume = Number(d.volume);
      amount = Number(d.amount);
    } else {
      // 新交易日：以昨收为基准做隔夜跳空开盘
      open = openWithGap(prevClose);
      price = open;
      high = open;
      low = open;
      volume = 0;
      amount = 0;
    }

    state.set(r.code, {
      code: r.code,
      name: r.name,
      sector: r.sector,
      shares: Number(r.shares) || sharesOf(r.code, prevClose),
      prevClose,
      open,
      price,
      high,
      low,
      volume,
      amount,
      history: [{ t: now, p: price }],
    });
  }

  // 无日线记录说明是全新的交易日，写入开盘记录
  if (daily.rows.length === 0 && state.size > 0) {
    await upsertDaily();
    await syncStocksOnOpen();
    await saveMeta();
  }

  logger.info('行情加载完成', {
    stocks: state.size,
    tradeSeq: meta.seq,
    sessionTick: meta.sessionTick,
    phase: meta.phase,
  });
}

// ---------- 交易日：开盘 / 收盘结算 ----------
function openWithGap(prevClose) {
  const gap = 1 + GAP_SIGMA * randn();
  const hi = prevClose * (1 + DAILY_LIMIT);
  const lo = prevClose * (1 - DAILY_LIMIT);
  return round2(Math.min(hi, Math.max(lo, prevClose * gap)));
}

function openSession(now) {
  for (const s of state.values()) {
    s.prevClose = s.price; // 昨收 = 上一交易日收盘
    s.open = openWithGap(s.prevClose); // 隔夜跳空开盘
    s.price = s.open;
    s.high = s.open;
    s.low = s.open;
    s.volume = 0;
    s.amount = 0;
    s.history = [{ t: now, p: s.open }];
  }
  meta.seq += 1;
  meta.sessionTick = 0;
  meta.phase = 'TRADING';
  meta.breakLeft = 0;
  meta.tradeDate = shToday();
  logger.info('新交易日开盘', { seq: meta.seq, date: meta.tradeDate, gapSigma: GAP_SIGMA });
}

async function closeSession(now) {
  for (const s of state.values()) {
    s.history.push({ t: now, p: s.price });
  }
  await upsertDaily(); // 日线落库（此时 prev_close 仍是本交易日的昨收）
  for (const s of state.values()) {
    s.prevClose = s.price; // 昨收滚动为今日收盘价
  }
  await syncStocksOnClose();
  await saveMeta();
  meta.sessionTick = 0;
  meta.phase = 'BREAK';
  meta.breakLeft = BREAK_TICKS;
  logger.info('交易日收盘结算', {
    seq: meta.seq,
    ticks: SESSION_TICKS,
    nextSeq: meta.seq + 1,
  });
}

// 真实时钟下的交易时段判断（9:30-11:30 / 13:00-15:00，周一至周五）
export function inTradingWindow(now = new Date()) {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = sh.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = sh.getUTCHours() * 60 + sh.getUTCMinutes();
  return (mins >= 570 && mins < 690) || (mins >= 780 && mins < 900);
}

// ---------- 盘中 tick ----------
export function tick() {
  const now = Date.now();

  // 真实时钟模式：非交易时段不产生行情
  if (REAL_CLOCK && !inTradingWindow(new Date(now))) {
    meta.phase = 'CLOSED';
    return;
  }

  // 休市：等待若干 tick 后开盘
  if (meta.phase === 'BREAK') {
    meta.breakLeft -= 1;
    if (meta.breakLeft > 0) {
      meta.sessionTick += 1;
      return;
    }
    openSession(now);
    Promise.all([upsertDaily(), syncStocksOnOpen()]).catch((e) =>
      logger.error('日线落库失败', { err: e })
    );
    saveMeta().catch((e) => logger.error('交易日历保存失败', { err: e }));
  } else if (meta.phase === 'CLOSED' && REAL_CLOCK) {
    meta.phase = 'TRADING';
  }

  const updates = [];
  for (const s of state.values()) {
    // 波动率随剩余时间缩放，避免长时间吸附涨跌停板
    const vol = INTRADAY_VOL;
    const drift = (Math.random() - 0.5) * 0.0004;
    // 轻微均值回复：价格偏离开盘越远，回归拉力越大，抑制单边涨跌停吸附
    const pull = ((s.open - s.price) / s.open) * 0.02;
    let np = s.price * (1 + drift + pull + vol * randn());
    const lo = s.prevClose * (1 - DAILY_LIMIT);
    const hi = s.prevClose * (1 + DAILY_LIMIT);
    np = round2(Math.min(hi, Math.max(lo, np)));
    s.price = np;
    if (np > s.high) s.high = np;
    if (np < s.low) s.low = np;

    // 成交量：基础随机量（与股本相关）+ 波动放大，收盘时重置
    const base = Math.max(20000, Math.round((s.shares || 1e8) * 0.00002));
    const amp = 0.5 + Math.random() + Math.abs((np - s.open) / s.open) * 8;
    s.volume += Math.floor(base * amp * 0.02);

    s.history.push({ t: now, p: np });
    if (s.history.length > MAX_HISTORY) s.history.shift();
    updates.push({
      code: s.code,
      price: s.price,
      high: s.high,
      low: s.low,
      volume: s.volume,
    });
  }

  meta.sessionTick += 1;
  tickCount += 1;

  const duePersist = tickCount % PERSIST_EVERY === 0;
  if (duePersist) {
    persist(updates).catch((e) => logger.error('行情落库失败', { err: e }));
    upsertDaily().catch((e) => logger.error('日线落库失败', { err: e }));
  }

  if (broadcaster) broadcaster(updates, now);

  // tick 后钩子：限价委托撮合等
  for (const fn of tickHooks) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') {
        r.catch((e) => logger.error('tick 钩子执行失败', { err: e }));
      }
    } catch (e) {
      logger.error('tick 钩子执行失败', { err: e });
    }
  }

  // 达到交易日长度则收盘结算
  if (meta.sessionTick >= SESSION_TICKS) {
    closeSession(now).catch((e) => logger.error('收盘结算失败', { err: e }));
  }
}

// 用户成交计入成交量与成交额（量价不再背离）
export function addTradeVolume(code, quantity, amount) {
  const s = state.get(code);
  if (!s) return;
  s.volume += quantity;
  s.amount = round2((s.amount || 0) + amount);
}

// ---------- 持久化 ----------
async function persist(updates) {
  if (updates.length === 0) return;
  // 批量 UPDATE（一次往返），替代逐条 UPDATE
  await pool.query(
    `UPDATE stocks AS s
        SET price = v.price,
            high = v.high,
            low = v.low,
            volume = v.volume,
            day_amount = v.amount,
            updated_at = now()
       FROM (
         SELECT * FROM unnest(
           $1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::bigint[], $6::numeric[]
         ) AS t(code, price, high, low, volume, amount)
       ) v
      WHERE s.code = v.code`,
    [
      updates.map((u) => u.code),
      updates.map((u) => u.price),
      updates.map((u) => u.high),
      updates.map((u) => u.low),
      updates.map((u) => u.volume),
      updates.map((u) => {
        const s = state.get(u.code);
        return s ? s.amount || 0 : 0;
      }),
    ]
  );
}

async function upsertDaily() {
  const codes = [];
  const seqs = [];
  const dates = [];
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const vols = [];
  const amounts = [];
  const prevs = [];
  for (const s of state.values()) {
    codes.push(s.code);
    seqs.push(meta.seq);
    dates.push(meta.tradeDate);
    opens.push(s.open);
    highs.push(s.high);
    lows.push(s.low);
    closes.push(s.price);
    vols.push(s.volume);
    amounts.push(s.amount || 0);
    prevs.push(s.prevClose);
  }
  if (codes.length === 0) return;
  await pool.query(
    `INSERT INTO stock_daily (code, seq, trade_date, open, high, low, close, volume, amount, prev_close)
     SELECT * FROM unnest(
       $1::text[], $2::int[], $3::date[], $4::numeric[], $5::numeric[], $6::numeric[],
       $7::numeric[], $8::bigint[], $9::numeric[], $10::numeric[]
     )
     ON CONFLICT (code, seq) DO UPDATE SET
       high = EXCLUDED.high,
       low = EXCLUDED.low,
       close = EXCLUDED.close,
       volume = EXCLUDED.volume,
       amount = EXCLUDED.amount,
       prev_close = EXCLUDED.prev_close`,
    [codes, seqs, dates, opens, highs, lows, closes, vols, amounts, prevs]
  );
}

// 开盘：滚动昨收与今开，重置当日量额
async function syncStocksOnOpen() {
  const list = [...state.values()];
  await pool.query(
    `UPDATE stocks AS s
        SET prev_close = v.prev_close,
            open_price = v.open,
            price = v.price,
            high = v.high,
            low = v.low,
            volume = 0,
            day_amount = 0
       FROM (
         SELECT * FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
         AS t(code, prev_close, open, price, high, low)
       ) v
      WHERE s.code = v.code`,
    [
      list.map((s) => s.code),
      list.map((s) => s.prevClose),
      list.map((s) => s.open),
      list.map((s) => s.price),
      list.map((s) => s.high),
      list.map((s) => s.low),
    ]
  );
}

// 收盘：把收盘价固化为下一交易日的昨收
async function syncStocksOnClose() {
  const list = [...state.values()];
  await pool.query(
    `UPDATE stocks AS s
        SET prev_close = v.prev_close,
            price = v.price,
            high = v.high,
            low = v.low,
            volume = v.volume,
            day_amount = v.amount
       FROM (
         SELECT * FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::bigint[], $7::numeric[])
         AS t(code, prev_close, price, high, low, volume, amount)
       ) v
      WHERE s.code = v.code`,
    [
      list.map((s) => s.code),
      list.map((s) => s.prevClose),
      list.map((s) => s.price),
      list.map((s) => s.high),
      list.map((s) => s.low),
      list.map((s) => s.volume),
      list.map((s) => s.amount || 0),
    ]
  );
}

// ---------- 查询 ----------
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

// 大盘指数：市值加权基点法（不再用等权平均价）
export function getSummary() {
  let up = 0;
  let down = 0;
  let flat = 0;
  let mktCap = 0;
  let baseCap = 0;
  for (const s of state.values()) {
    const ch = s.price - s.prevClose;
    if (ch > 0) up += 1;
    else if (ch < 0) down += 1;
    else flat += 1;
    const shares = s.shares || sharesOf(s.code, s.prevClose);
    mktCap += s.price * shares;
    baseCap += s.prevClose * shares;
  }
  return {
    up,
    down,
    flat,
    total: state.size,
    indexValue: baseCap ? round2((mktCap / baseCap) * INDEX_BASE) : INDEX_BASE,
    indexPct: baseCap ? round2((mktCap / baseCap - 1) * 100) : 0,
  };
}

export function getMarketStatus() {
  return {
    tradeSeq: meta.seq,
    tradeDate: meta.tradeDate,
    phase: meta.phase,
    sessionTick: meta.sessionTick,
    sessionTicks: SESSION_TICKS,
    ticksToClose: Math.max(0, SESSION_TICKS - meta.sessionTick),
    breakLeft: meta.breakLeft,
    realClock: REAL_CLOCK,
    inWindow: REAL_CLOCK ? inTradingWindow() : true,
    tickMs: TICK_MS,
    dailyLimit: DAILY_LIMIT,
  };
}

// 演示用：强制进入下一交易日
export async function forceNextSession() {
  const now = Date.now();
  if (meta.phase !== 'BREAK') await closeSession(now);
  openSession(now);
  await upsertDaily();
  await syncStocksOnOpen();
  await saveMeta();
  return getMarketStatus();
}

export function startMarket() {
  // 用 try/catch 包住，单次 tick 异常不会中断整个定时器
  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      logger.error('行情 tick 执行异常', { err: e });
    }
  }, TICK_MS);
  logger.info('行情引擎启动', {
    tickMs: TICK_MS,
    stocks: state.size,
    sessionTicks: SESSION_TICKS,
    realClock: REAL_CLOCK,
  });
  return timer;
}
