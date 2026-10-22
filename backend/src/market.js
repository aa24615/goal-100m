import pool from './db.js';
import { logger } from './logger.js';
import {
  getLatestQuotes,
  getLastFetchAt,
  quoteFeedStatus,
  startQuoteFeed,
  refreshQuotes,
} from './services/quoteFeed.js';

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
let lastAppliedAt = 0; // 已应用的行情快照时间戳，避免同一份快照被反复广播
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

/**
 * pg 的 date 是本地时区 0 点的 Date，不能用 toISOString()（UTC+8 下会整体退一天），
 * 必须用本地日期分量格式化，否则交易日匹配会错位。
 */
function toDateStr(v) {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// 代码稳定散列，用于生成股本（保证每次运行一致）
export function hashOf(code) {
  let h = 0;
  for (let i = 0; i < code.length; i += 1) h = (h * 31 + code.charCodeAt(i)) % 100003;
  return h % 1000;
}

export function sharesOf(code, prevClose) {
  // pg 的 numeric/bigint 会以字符串返回，"0.00" 是 truthy，不能靠 || 兜底，必须显式数值判断
  const base = Number(prevClose) > 0 ? Number(prevClose) : 10;
  const marketCap = 8e9 + (hashOf(code) / 1000) * 2.9e10; // 80 亿 ~ 370 亿市值
  return Math.round(marketCap / base / 1e4) * 1e4; // 取整到万股
}

// 股本回填：seed 阶段若未写入 shares，则按市值估算补全（仅数据，不涉及表结构）
export async function backfillStockShares() {
  const r = await pool.query('SELECT code, price, prev_close, shares FROM stocks');
  for (const row of r.rows) {
    const has = Number(row.shares);
    if (Number.isFinite(has) && has > 0) continue;
    const prev = Number(row.prev_close) || Number(row.price) || 0;
    // 无有效价格（停牌/无日线）时给中性股本，避免除零产生 Infinity 写坏 bigint 字段
    const shares = prev > 0 ? sharesOf(row.code, prev) : 100000000;
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

  // 真实数据下，交易日序号必须对齐真实日期：
  // 用「不晚于今天的最近一个交易日」作为当前交易日，避免沿用模拟盘遗留的 seq（1,2,3...）
  const today = shToday();
  const { rows: lastCal } = await pool.query(
    'SELECT seq, trade_date FROM trade_calendar WHERE trade_date <= $1 ORDER BY trade_date DESC LIMIT 1',
    [today]
  );
  if (lastCal.length > 0) {
    meta.seq = lastCal[0].seq;
    meta.tradeDate = toDateStr(lastCal[0].trade_date);
  } else {
    meta.seq = await seqForDate(today);
    meta.tradeDate = today;
  }

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

// ---------- 盘中 tick（价格来自真实行情快照，不再随机游走） ----------

/** 把最新真实快照应用到内存行情；返回发生变化的标的 */
function applyQuotes(now) {
  const q = getLatestQuotes();
  const updates = [];
  for (const s of state.values()) {
    const quote = q.get(s.code);
    if (!quote || !(quote.price > 0)) continue; // 停牌/无报价沿用上一次价格
    const prevPrice = s.price;
    const prevVolume = s.volume;
    s.prevClose = quote.prevClose || s.prevClose;
    s.open = quote.open || s.open;
    s.high = quote.high || s.high;
    s.low = quote.low || s.low;
    s.price = quote.price;
    s.volume = quote.volume || s.volume;
    s.amount = quote.amount || s.amount;
    // 收盘/夜间价格不再变化时不做无效广播（否则每 5 秒推送 5000+ 条相同数据）
    if (s.price === prevPrice && s.volume === prevVolume) continue;
    s.history.push({ t: now, p: s.price });
    if (s.history.length > MAX_HISTORY) s.history.shift();
    updates.push({ code: s.code, price: s.price, high: s.high, low: s.low, volume: s.volume });
  }
  return updates;
}

/** 查交易日历；当天不在日历中（如临时新增）则顺延一个新序号 */
async function seqForDate(d) {
  const { rows } = await pool.query('SELECT seq FROM trade_calendar WHERE trade_date = $1', [d]);
  if (rows.length > 0) return rows[0].seq;
  const { rows: mx } = await pool.query('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM trade_calendar');
  await pool.query(
    'INSERT INTO trade_calendar (seq, trade_date) VALUES ($1, $2) ON CONFLICT (trade_date) DO NOTHING',
    [mx[0].s, d]
  );
  return mx[0].s;
}

/** 跨自然日时推进交易日：昨收滚动为上一日收盘，重置当日量额 */
async function ensureTradingDay() {
  const today = shToday();
  if (meta.tradeDate === today) return;
  for (const s of state.values()) {
    s.prevClose = s.price;
    s.volume = 0;
    s.amount = 0;
    s.history = [{ t: Date.now(), p: s.price }];
  }
  meta.tradeDate = today;
  meta.seq = await seqForDate(today);
  meta.phase = 'TRADING';
  await saveMeta();
  logger.info('进入新交易日', { date: today, seq: meta.seq });
}

export function tick() {
  const now = Date.now();

  // 只有拿到「新的」真实快照才更新，避免同一份数据被反复广播
  const qAt = getLastFetchAt();
  if (!qAt || qAt === lastAppliedAt) return;
  lastAppliedAt = qAt;

  const updates = applyQuotes(now);
  if (updates.length === 0) return;

  // 交易日推进（按真实日期）
  ensureTradingDay().catch((e) => logger.error('交易日推进失败', { err: e }));

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
    // 昨收为 0（停牌/无数据）时不能做除法，否则得到 Infinity/NaN 直接污染前端展示
    changePct: s.prevClose > 0 ? round2(((s.price - s.prevClose) / s.prevClose) * 100) : 0,
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
    // 真实数据相关
    dataSource: 'REAL', // 已切换为真实 A 股行情，不再是随机模拟
    stocks: state.size,
    realQuotes: getLatestQuotes().size,
    quote: quoteFeedStatus(),
    inTradingWindow: inTradingWindow(),
  };
}

// 真实行情模式下不再支持「跳到下一交易日」（那会凭空造出假的开盘价），
// 保留接口以兼容前端，行为改为立即刷新一次真实快照并返回当前状态。
export async function forceNextSession() {
  await refreshQuotes();
  return getMarketStatus();
}

export function startMarket() {
  // 真实行情：启动快照拉取（价格由数据源驱动，tick 不再随机游走）
  startQuoteFeed(inTradingWindow);
  // 用 try/catch 包住，单次 tick 异常不会中断整个定时器
  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      logger.error('行情 tick 执行异常', { err: e });
    }
  }, TICK_MS);
  logger.info('行情引擎启动（真实行情）', {
    tickMs: TICK_MS,
    stocks: state.size,
    tradeDate: meta.tradeDate,
    seq: meta.seq,
    realClock: REAL_CLOCK,
  });
  return timer;
}
