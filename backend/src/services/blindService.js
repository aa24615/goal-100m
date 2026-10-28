/**
 * 双盲训练场服务（RQ-66 双盲 / RQ-67 随机来一段 / RQ-38 决策记录 / RQ-41 成绩）
 *
 * 与既有 Replay 的分工：
 *   - Replay：用户**自己选**区间，知道是哪只票哪一天，用于「验证某个判断」；
 *   - Blind ：系统**随机**给真实历史片段，遮蔽代码/名称/日期，用于「防后视镜」。
 * 两者共用 replayService.simulateReplay 的纯计算内核，因此资金、T+1、费用、
 * 分板块涨跌停（RQ-49）口径与实时盘一致，成绩可跨模块比较。
 *
 * 隔离：只写 blind_* 表，绝不触碰 users / holdings / transactions（RQ-42）。
 */

import pool from '../db.js';
import { logger } from '../logger.js';
import { simulateReplay } from './replayService.js';
import { clampLimit } from '../utils/num.js';
import { buildCheckup, buildPrescription, disciplineRate, SAMPLE_THRESHOLD } from './checkupService.js';
import { round2, pct2 } from '../utils/time.js';
import { identityOf } from './guestService.js';
import { DEFAULT_BARS, MIN_BARS, DEFAULT_PRESET_KEY } from './sessionLengthService.js';

const DEFAULT_CAPITAL = 1000000;
/**
 * 盲测片段长度（根 K 线）与最小长度现由 sessionLengthService 唯一定义：
 * RQ-107 把默认从 60 根下调为 12 根（快局），并把下限从 20 下调到 10。
 * 两处若各写一份，「默认一局 ≤15 根」的验收口径会悄悄漂回去。
 */
const MAX_BARS = 200;
/** 每 N 根 K 线要求记录一次决策（RQ-38） */
export const DECISION_INTERVAL = 10;
/** 「有流动性」的门槛：区间内日均成交额（元），低于此值的标的不进入随机池 */
const MIN_AVG_AMOUNT = 5_000_000;

/* ------------------------------------------------------------------ *
 * RQ-81 多周期粒度                                                     *
 * ------------------------------------------------------------------ *
 * Q6（分钟级数据是否可得）未确认前，只支持日线。
 * 这里把「支持什么、不支持什么」写成常量而不是散落在判断里，
 * 是为了让页面能直接渲染「当前仅日线」而不是假装支持后返回空数据。
 */
export const GRANULARITIES = [
  { key: 'day', label: '日线', available: true, note: '每个 seq 对应一个交易日，数据完整' },
  { key: 'm60', label: '60 分钟', available: false, note: '分钟级数据源未接入，暂不可用' },
  { key: 'm30', label: '30 分钟', available: false, note: '分钟级数据源未接入，暂不可用' },
  { key: 'm15', label: '15 分钟', available: false, note: '分钟级数据源未接入，暂不可用' },
  { key: 'm5', label: '5 分钟', available: false, note: '分钟级数据源未接入，暂不可用' },
];
export const DEFAULT_GRANULARITY = 'day';

export function isGranularityAvailable(key) {
  const g = GRANULARITIES.find((x) => x.key === String(key || '').toLowerCase());
  return Boolean(g && g.available);
}

/* ------------------------------------------------------------------ *
 * RQ-82 片段特征标签                                                   *
 * ------------------------------------------------------------------ *
 * 四类：趋势 / 震荡 / 回撤 / 高波动。
 * 全部由**真实日线**算出（纯算术、不接 AI），因此「标签与真实行情特征一致」
 * 这条验收标准可以被单测直接验证，而不依赖人工目测。
 */
export const SEGMENT_TAGS = {
  trend: { key: 'trend', label: '趋势', desc: '方向明确、回撤小的单边行情，练「拿得住」' },
  range: { key: 'range', label: '震荡', desc: '反复上下、没有方向，练「看不懂就不动」' },
  pullback: { key: 'pullback', label: '回撤', desc: '自高点明显回落，练「计划止损先写后做」' },
  volatile: { key: 'volatile', label: '高波动', desc: '日内跳动放大，练「情绪上头时不动手」' },
};

/** 分类阈值：集中在一处，便于按 A 股实际波动水平校准 */
export const TAG_THRESHOLDS = {
  volatileVol: 0.025, // 日收益标准差 ≥ 2.5% → 高波动
  pullbackDD: 0.15, // 最大回撤 ≥ 15% → 具备回撤特征
  pullbackNetMax: 0.05, // 且净收益 < 5%（涨回去的不算回撤）
  trendNet: 0.2, // 净收益绝对值 ≥ 20% → 具备方向
  trendEfficiency: 0.3, // 且 |净收益| ÷ 累计波动 ≥ 30%（走得干脆，不是来回蹭上去）
};

/**
 * 由收盘价序列算出片段特征（纯函数，可单测）。
 *
 * @param {number[]} closes 按时间升序的收盘价
 * @returns {object|null} { tag, label, metrics } ；数据不足返回 null
 */
export function classifySegment(closes) {
  const arr = Array.isArray(closes) ? closes.map((c) => Number(c)).filter((c) => Number.isFinite(c) && c > 0) : [];
  if (arr.length < 3) return null;

  const rets = [];
  for (let i = 1; i < arr.length; i += 1) rets.push(arr[i] / arr[i - 1] - 1);

  const netReturn = arr[arr.length - 1] / arr[0] - 1;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const vol = Math.sqrt(variance);
  const sumAbs = rets.reduce((s, r) => s + Math.abs(r), 0);
  // 效率比：净移动 ÷ 累计路程。≈1 是直线上涨，≈0 是原地打转
  const efficiency = sumAbs > 0 ? Math.abs(netReturn) / sumAbs : 0;

  let peak = arr[0];
  let maxDD = 0;
  for (const c of arr) {
    if (c > peak) peak = c;
    const dd = peak > 0 ? (peak - c) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const t = TAG_THRESHOLDS;
  let tag = 'range';
  if (vol >= t.volatileVol) tag = 'volatile';
  else if (maxDD >= t.pullbackDD && netReturn < t.pullbackNetMax) tag = 'pullback';
  else if (Math.abs(netReturn) >= t.trendNet && efficiency >= t.trendEfficiency) tag = 'trend';

  return {
    tag,
    label: SEGMENT_TAGS[tag].label,
    desc: SEGMENT_TAGS[tag].desc,
    metrics: {
      bars: arr.length,
      netReturn: round2(netReturn * 100),
      volatility: round2(vol * 100),
      maxDrawdown: round2(maxDD * 100),
      efficiency: round2(efficiency * 100),
    },
  };
}

export function isValidTag(tag) {
  return Object.prototype.hasOwnProperty.call(SEGMENT_TAGS, String(tag || '').toLowerCase());
}

/* ------------------------------------------------------------------ *
 * RQ-101 前后端标签与参数字典唯一源                                    *
 * ------------------------------------------------------------------ *
 * F-25 的直接成因：标签字典存在 `sideways` 与 `range` 两种写法，
 * 一侧按 `range` 发、另一侧按 `sideways` 收，于是每次调用都吃一个 400，
 * 真实问题被噪声淹没——**日志不可读就等于没有日志**。
 *
 * 处理原则：**归一而不是拒绝**。历史写法是兼容问题，不是用户错误，
 * 把它折算成规范值即可，没必要让用户为一个拼写差异买单。
 * 真正非法的标签仍然 400，但错误信息里会列出规范值。
 */
export const SEGMENT_TAG_ALIASES = {
  sideways: 'range',
  shock: 'range',
  oscillation: 'range',
  box: 'range',
  uptrend: 'trend',
  downtrend: 'trend',
  drawdown: 'pullback',
  retracement: 'pullback',
  highvol: 'volatile',
  volatility: 'volatile',
};

/**
 * 把任意历史写法折算成规范标签；无法识别返回 null。
 * 纯函数，可单测；null / 非字符串一律返回 null。
 */
export function normalizeSegmentTag(tag) {
  if (tag == null) return null;
  const raw = String(tag).trim().toLowerCase();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(SEGMENT_TAGS, raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(SEGMENT_TAG_ALIASES, raw)) return SEGMENT_TAG_ALIASES[raw];
  return null;
}

/** 标签解析结果：{ ok, tag } —— 调用方据此决定「归一」还是「报错」 */
export function resolveSegmentTag(tag) {
  const norm = normalizeSegmentTag(tag);
  return norm ? { ok: true, tag: norm } : { ok: false, tag: null, allowed: Object.keys(SEGMENT_TAGS) };
}

/** 取某标的某区间的收盘价（升序），仅用于特征分类 */
async function loadCloses(code, startSeq, endSeq) {
  const { rows } = await pool.query(
    'SELECT close FROM stock_daily WHERE code=$1 AND seq BETWEEN $2 AND $3 ORDER BY seq ASC',
    [code, startSeq, endSeq]
  );
  return rows.map((r) => Number(r.close));
}

export function blindError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  e.business = true;
  return e;
}

function clampBars(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_BARS;
  return Math.min(MAX_BARS, Math.max(MIN_BARS, Math.floor(v)));
}

/* ------------------------------------------------------------------ *
 * RQ-108 归属：登录用户走 user_id，游客走 guest_token                  *
 * ------------------------------------------------------------------ *
 * 游客会话的 user_id 恒为 NULL（迁移 0019 已放开 NOT NULL），
 * 因此所有按人查会话的 SQL 都不能再写死 `user_id=$2`。
 * 这里统一产出归属条件，避免某个接口漏改后游客能看到别人的训练。
 */

/**
 * @param {object} identity { userId, guestToken }
 * @param {number} nextIndex 该条件在 SQL 中的起始占位符序号
 * @returns {{sql:string, params:Array, nextIndex:number}}
 */
function ownerWhere(identity, nextIndex = 2) {
  const id = identityOf(identity);
  if (id.userId) {
    return { sql: `user_id=$${nextIndex}`, params: [id.userId], nextIndex: nextIndex + 1 };
  }
  if (id.guestToken) {
    return { sql: `guest_token=$${nextIndex}`, params: [id.guestToken], nextIndex: nextIndex + 1 };
  }
  // 无身份：用永远为假的条件，而不是放行——防止「没传身份」被当成「不过滤」
  return { sql: 'FALSE', params: [], nextIndex };
}

/* ------------------------------------------------------------------ *
 * RQ-66 遮蔽：任何在训练中暴露身份的字段都必须在这里被剥掉            *
 * ------------------------------------------------------------------ */

/**
 * 生成本次训练对外代号。用随机后缀而非序号，避免「第 N 次训练」被反推成日期。
 */
export function makeAlias(seed) {
  const n = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : Math.floor(Math.random() * 0xffff);
  return `标的 #${(n % 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * 遮蔽后的 K 线：只保留走势本身（序号 + OHLCV），
 * **不含 code / name / trade_date** —— 日期与代码是后视镜的两条主渠道。
 */
export function maskBars(bars = [], uptoSeq = null) {
  return bars
    .filter((b) => uptoSeq == null || b.seq <= uptoSeq)
    .map((b, i) => {
      const code = Object.keys(b.prices || {})[0];
      const p = code ? b.prices[code] : null;
      return {
        // 相对序号（1..N），不暴露真实 seq，避免用户拿 seq 去对日历
        i: i + 1,
        open: p ? Number(p.open) : null,
        high: p ? Number(p.high) : null,
        low: p ? Number(p.low) : null,
        close: p ? Number(p.close) : null,
        volume: p ? Number(p.volume || 0) : 0,
      };
    });
}

/**
 * 训练态视图：不含任何身份字段；reveal 之后才返回 code / name / 日期。
 *
 * 注意：持仓、成交、被拒记录里都带 `code`，直接透出等于把标的身份原样送回前端
 * —— 双盲就失效了（RQ-66 验收标准：训练全程无法从界面推断标的身份与日期）。
 * 因此未揭示时统一按 ALIAS 覆盖，只保留数量/价格/盈亏这些与身份无关的字段。
 */
export function blindView(session, state, { reveal = false, revealed = null } = {}) {
  const alias = session.alias;
  const stripCode = (o) => (o == null ? o : { ...o, code: alias });
  const positions = reveal ? state.positions || [] : (state.positions || []).map(stripCode);
  const trades = reveal ? state.trades || [] : (state.trades || []).map(stripCode);
  const rejected = reveal ? state.rejected || [] : (state.rejected || []).map(stripCode);

  const base = {
    id: session.id,
    alias,
    status: session.status,
    // 训练中不返回真实 seq：seq 与交易日历一一对应，等于把日期原样送出去（RQ-66）
    cursorSeq: reveal ? session.cursor_seq : null,
    // 相对位置而非真实 seq：真实 seq 可对上交易日历，是后视镜的第二条渠道
    cursorIndex: session.cursor_seq - session.start_seq + 1,
    totalBars: session.end_seq - session.start_seq + 1,
    capital: state.initialCapital,
    cash: state.cash,
    positions,
    trades,
    rejected,
    equity: (state.equity || []).map((e) => ({
      i: e.seq - session.start_seq + 1,
      cash: e.cash,
      marketValue: e.marketValue,
      totalAssets: e.totalAssets,
    })),
    realizedTotal: state.realizedTotal,
    feeTotal: state.feeTotal,
    tradeCount: state.tradeCount,
    maxDrawdown: state.maxDrawdown,
    atEnd: session.cursor_seq >= session.end_seq,
    // 决策点：每 DECISION_INTERVAL 根一个，训练中即可知「还有几个点要写」
    decisionPoints: decisionPointsOf(session).map((s) => s - session.start_seq + 1),
  };
  if (!reveal) return base;
  return {
    ...base,
    revealed: revealed || {
      code: session.stock_code,
      name: session.stock_name,
      startSeq: session.start_seq,
      endSeq: session.end_seq,
    },
  };
}

/** 决策点 seq 列表：从片段第 1 根起，每 DECISION_INTERVAL 根一个 */
export function decisionPointsOf(session) {
  const pts = [];
  for (let s = session.start_seq; s <= session.end_seq; s += 1) {
    if ((s - session.start_seq) % DECISION_INTERVAL === 0) pts.push(s);
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * RQ-67 随机来一段                                                    *
 * ------------------------------------------------------------------ */

/**
 * 随机抽取一段真实历史片段。
 *
 * 抽取策略（保证均匀且可重复抽到不同片段）：
 *   1) 先从「有流动性」的标的池里随机挑一只（日均成交额门槛，避免抽到僵尸股）；
 *   2) 在该标的可用的 seq 区间内随机取起点，保证整段完整（起点 + bars − 1 ≤ maxSeq）。
 *
 * @param {object} o { bars, liquidOnly }
 */
export async function pickRandomSegment({ bars = DEFAULT_BARS, liquidOnly = true, tag = null } = {}) {
  const n = clampBars(bars);
  // RQ-82 按标签抽取：非法标签直接拒绝，避免静默退化为「随机」后用户以为自己在定向练。
  // RQ-101 先做归一化：历史写法（sideways 等）折算为规范标签，不再产生 400 噪声。
  const resolved = resolveSegmentTag(tag);
  const wantTag = resolved.ok ? resolved.tag : null;
  if (tag && !wantTag) {
    throw blindError(`未知的片段类型：${String(tag)}（可选 ${Object.keys(SEGMENT_TAGS).join(' / ')}）`, 400);
  }

  // 先确定全局 seq 上下界，避免对每只票重复求 MIN/MAX
  const { rows: rangeRows } = await pool.query(
    'SELECT MIN(seq)::int AS minseq, MAX(seq)::int AS maxseq FROM stock_daily'
  );
  const gMin = rangeRows[0]?.minseq;
  const gMax = rangeRows[0]?.maxseq;
  if (gMin == null || gMax == null || gMax - gMin + 1 < n) {
    // 用 400 而不是 5xx：middleware 只对 4xx 走「业务规则拒绝」分支，
    // 返回 503 会被 clientErrorStatus 判定为服务端故障 → 500 + ERROR 日志，
    // 把「没有可用数据」伪装成线上故障。
    throw blindError('可回放的真实历史数据不足，无法生成盲测片段', 400);
  }

  // 候选标的：区间内数据完整（根数 >= n）且流动性达标。
  // 注意列名必须带表别名——stock_daily 与 stocks 都有 code/name，
  // 不限定会让 PostgreSQL 报 "column reference is ambiguous"，最终变成 500。
  const { rows: candidates } = await pool.query(
    `SELECT d.code AS code, s.name AS name, COUNT(*)::int AS cnt,
            MIN(d.seq)::int AS minseq, MAX(d.seq)::int AS maxseq,
            AVG(d.amount)::float AS avg_amount
       FROM stock_daily d
       JOIN stocks s ON s.code = d.code
      WHERE s.trade_status = 'NORMAL'
      GROUP BY d.code, s.name
     HAVING COUNT(*) >= $1
        AND ($2::boolean = false OR AVG(d.amount) >= $3)`,
    [n, Boolean(liquidOnly), MIN_AVG_AMOUNT]
  );
  if (candidates.length === 0) {
    // 流动性门槛过严时退化为全市场，宁可抽到冷门股也不要「抽不出片段」
    const { rows: all } = await pool.query(
      `SELECT d.code AS code, s.name AS name, COUNT(*)::int AS cnt,
              MIN(d.seq)::int AS minseq, MAX(d.seq)::int AS maxseq,
              AVG(d.amount)::float AS avg_amount
         FROM stock_daily d
         JOIN stocks s ON s.code = d.code
        WHERE s.trade_status = 'NORMAL'
        GROUP BY d.code, s.name
       HAVING COUNT(*) >= $1`,
      [n]
    );
    if (all.length === 0) throw blindError('没有满足长度要求的标的，无法生成盲测片段', 400);
    return chooseSegment(all, n, wantTag);
  }
  return chooseSegment(candidates, n, wantTag);
}

/**
 * 均匀随机：先随机标的，再在其可用起点范围内随机起点。
 *
 * RQ-82：无论是否指定标签，都会对抽中的片段做一次特征分类并带回 tag ——
 * 不指定标签时也要落库，否则历史列表无法回看「这段练的是什么」。
 * 指定标签时按「重采样直到匹配」实现：比在 SQL 里做窗口函数算波动率简单得多，
 * 且抽不到时给出明确 400，而不是静默返回一个不匹配的片段。
 */
async function chooseSegment(candidates, n, wantTag = null) {
  const maxAttempts = wantTag ? 40 : 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const c = candidates[Math.floor(Math.random() * candidates.length)];
    const lo = c.minseq;
    const hi = c.maxseq - n + 1;
    if (hi < lo) continue;
    const start = lo + Math.floor(Math.random() * (hi - lo + 1));
    const endSeq = start + n - 1;

    const cls = classifySegment(await loadCloses(c.code, start, endSeq));
    if (wantTag && (!cls || cls.tag !== wantTag)) continue;

    return {
      code: c.code,
      name: c.name,
      startSeq: start,
      endSeq,
      bars: n,
      tag: cls ? cls.tag : null,
      tagMetrics: cls ? cls.metrics : null,
    };
  }
  if (wantTag) {
    throw blindError(
      `连续 ${maxAttempts} 次未抽到「${SEGMENT_TAGS[wantTag].label}」特征的片段，请换一个类型或去掉筛选后重试`,
      400
    );
  }
  throw blindError('随机片段抽取失败，请重试', 400);
}

/* ------------------------------------------------------------------ *
 * 会话生命周期                                                        *
 * ------------------------------------------------------------------ */

/**
 * 片段 K 线。**必须按 code 过滤**：不过滤会把同区间所有标的都捞出来，
 * 而 maskBars 只取 prices 的第一个 key，训练者看到的将是「随机另一只票」的走势，
 * 与成绩里揭示的标的对不上——双盲的对照就失效了。
 */
async function loadBars(startSeq, endSeq, code = null) {
  const { rows } = await pool.query(
    `SELECT seq, code, open, high, low, close, prev_close, volume
       FROM stock_daily
      WHERE seq BETWEEN $1 AND $2 ${code ? 'AND code = $3' : ''}
      ORDER BY seq ASC`,
    code ? [startSeq, endSeq, code] : [startSeq, endSeq]
  );
  const bySeq = new Map();
  for (const r of rows) {
    if (!bySeq.has(r.seq)) bySeq.set(r.seq, { seq: r.seq, prices: {} });
    bySeq.get(r.seq).prices[r.code] = {
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      prevClose: Number(r.prev_close || r.close),
      volume: Number(r.volume || 0),
    };
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

async function loadOrders(sessionId) {
  const { rows } = await pool.query(
    'SELECT seq, stock_code, side, quantity FROM blind_orders WHERE session_id=$1 ORDER BY seq ASC, id ASC',
    [sessionId]
  );
  return rows.map((r) => ({ seq: r.seq, code: r.stock_code, side: r.side, quantity: r.quantity }));
}

async function loadMeta(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (list.length === 0) return {};
  const { rows } = await pool.query('SELECT code, name, listing_date FROM stocks WHERE code = ANY($1::text[])', [list]);
  const m = {};
  for (const r of rows) {
    m[r.code] = { name: r.name, listingDate: r.listing_date ? String(r.listing_date).slice(0, 10) : null };
  }
  return m;
}

/**
 * 开始一次双盲训练。
 * @param {object} o { userId, guestToken, bars, liquidOnly, code, startSeq, endSeq, preset }
 *   指定 code/startSeq/endSeq 时走「定向片段」；否则随机（RQ-67）。
 *   RQ-108：不传 userId 而传 guestToken 时创建**游客局**（user_id 为 NULL）。
 *   RQ-107：preset 决定局长度档位，缺省走默认快局（12 根）。
 */
export async function startBlind({
  userId = null,
  guestToken = null,
  bars,
  liquidOnly = true,
  code,
  startSeq,
  endSeq,
  tag = null,
  prescriptionKey = null,
  granularity = DEFAULT_GRANULARITY,
  preset = null,
} = {}) {
  const owner = identityOf({ userId, guestToken });
  if (owner.anonymous) throw blindError('缺少归属身份：请登录后开始，或带上游客 token', 400);
  // RQ-81 粒度校验前置：分钟级数据未接入时必须明确拒绝，
  // 否则用户以为自己在练日内，实际拿到的是日线，训练结论会错位。
  const gkey = String(granularity || DEFAULT_GRANULARITY).toLowerCase();
  if (!isGranularityAvailable(gkey)) {
    throw blindError(
      `暂不支持「${gkey}」粒度：分钟级行情数据源尚未接入，当前仅提供日线（day）训练`,
      400
    );
  }

  let seg;
  if (code && Number.isInteger(Number(startSeq)) && Number.isInteger(Number(endSeq))) {
    seg = { code: String(code).toUpperCase(), name: '', startSeq: Number(startSeq), endSeq: Number(endSeq) };
    const { rows } = await pool.query('SELECT name FROM stocks WHERE code=$1', [seg.code]);
    if (rows.length === 0) throw blindError('标的不存在', 404);
    seg.name = rows[0].name;
    const cls = classifySegment(await loadCloses(seg.code, seg.startSeq, seg.endSeq));
    seg.tag = cls ? cls.tag : null;
    seg.tagMetrics = cls ? cls.metrics : null;
  } else {
    seg = await pickRandomSegment({ bars, liquidOnly, tag });
  }
  const n = clampBars(bars);
  if (seg.endSeq - seg.startSeq + 1 < MIN_BARS) throw blindError('片段长度不足', 400);

  const { rows } = await pool.query(
    `INSERT INTO blind_sessions
       (user_id, guest_token, preset, stock_code, stock_name, alias, start_seq, end_seq, cursor_seq,
        initial_capital, status, segment_tag, tag_metrics, prescription_key, granularity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RUNNING',$11,$12,$13,$14) RETURNING *`,
    [
      owner.userId,
      owner.guestToken,
      String(preset || DEFAULT_PRESET_KEY).slice(0, 16),
      seg.code,
      seg.name,
      makeAlias(Date.now() ^ Math.floor(Math.random() * 0xffff)),
      seg.startSeq,
      seg.endSeq,
      seg.startSeq,
      DEFAULT_CAPITAL,
      seg.tag || null,
      seg.tagMetrics ? JSON.stringify(seg.tagMetrics) : null,
      prescriptionKey ? String(prescriptionKey).slice(0, 32) : null,
      gkey,
    ]
  );
  logger.info('双盲训练开始', {
    userId: owner.userId,
    guest: owner.isGuest,
    sessionId: rows[0].id,
    code: seg.code,
    startSeq: seg.startSeq,
    endSeq: seg.endSeq,
    bars: n,
    preset: preset || DEFAULT_PRESET_KEY,
    tag: seg.tag,
    prescriptionKey: prescriptionKey || null,
    granularity: gkey,
  });
  return rows[0];
}

/** 兼容两种调用：getBlindSession(userId, id) 与 getBlindSession({userId, guestToken}, id) */
function asIdentity(v) {
  if (v && typeof v === 'object') return identityOf(v);
  return identityOf({ userId: v });
}

export async function getBlindSession(userId, sessionId, { reveal = false } = {}) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(`SELECT * FROM blind_sessions WHERE id=$1 AND ${w.sql}`, [sessionId, ...w.params]);
  if (rows.length === 0) return null;
  const session = rows[0];
  const isOver = reveal || session.status === 'FINISHED';
  const [bars, orders] = await Promise.all([
    loadBars(session.start_seq, session.end_seq, session.stock_code),
    loadOrders(session.id),
  ]);
  const state = simulateReplay({
    initialCapital: Number(session.initial_capital),
    bars,
    orders,
    uptoSeq: session.cursor_seq,
    stockMeta: await loadMeta([session.stock_code]),
  });
  state.initialCapital = Number(session.initial_capital);
  // 决策点的真实 seq 同样能反查日期，训练中只给相对序号
  const decisions = (await listDecisions(session.id)).map((d) => ({
    ...d,
    seq: isOver ? d.seq : d.seq - session.start_seq + 1,
  }));
  const masked = blindView(session, state, {
    reveal: isOver,
    revealed:
      reveal || session.status === 'FINISHED'
        ? {
            code: session.stock_code,
            name: session.stock_name,
            startSeq: session.start_seq,
            endSeq: session.end_seq,
            dates: bars.length > 0 ? { from: null, to: null } : null,
          }
        : null,
  });
  return { session, state, view: { ...masked, decisions }, bars, maskedBars: maskBars(bars, session.cursor_seq) };
}

/** 推进游标（下一根 / 上一根 / 跳到） */
export async function stepBlind(userId, sessionId, action = 'next', seq = null) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(`SELECT * FROM blind_sessions WHERE id=$1 AND ${w.sql}`, [sessionId, ...w.params]);
  if (rows.length === 0) return null;
  const s = rows[0];
  if (s.status === 'FINISHED') throw blindError('该训练已结束', 400);

  let next = s.cursor_seq;
  if (action === 'next') next = Math.min(s.end_seq, s.cursor_seq + 1);
  else if (action === 'prev') next = Math.max(s.start_seq, s.cursor_seq - 1);
  else if (action === 'seek') {
    const t = Number(seq);
    if (!Number.isInteger(t) || t < s.start_seq || t > s.end_seq) throw blindError('目标位置超出片段范围', 400);
    next = t;
  } else if (action === 'hold') {
    next = s.cursor_seq;
  } else throw blindError('未知的步进动作', 400);

  await pool.query('UPDATE blind_sessions SET cursor_seq=$1, last_active_at=now() WHERE id=$2', [next, s.id]);
  return getBlindSession(userId, s.id);
}

/* ------------------------------------------------------------------ *
 * RQ-91 训练会话持久化与断点续做                                      *
 * ------------------------------------------------------------------ *
 * v8 实地复核：`blind_sessions` 序列已用至 4，**表内 0 行**——
 * 开始了 4 次训练，一次进度都没留下（F-17）。碎片时间训练（通勤 / 休市）
 * 一旦被打断就前功尽弃，而且**没有任何提示告知会丢失**。
 *
 * 落库本身在 startBlind 里就做了（INSERT ... RETURNING），缺的是两件事：
 *   ① 一个「我上次练到哪了」的查询入口；
 *   ② 一句明确的断点提示（「上次停在第 N 根」）。
 * 这里补的就是这两件，并且把提示文案做成纯函数，好让它能被单测直接验收。
 */

/**
 * 断点提示（纯函数）。
 *
 * @param {object|null} session blind_sessions 行
 * @returns {object} { resumable, sessionId, cursorIndex, totalBars, text, ... }
 */
export function buildResumeHint(session) {
  const s = session && typeof session === 'object' ? session : null;
  const empty = { resumable: false, reason: '没有可续做的训练', text: '' };
  if (!s) return empty;

  const startSeq = Number(s.start_seq);
  const endSeq = Number(s.end_seq);
  const cursorSeq = Number(s.cursor_seq);
  if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq) || !Number.isFinite(cursorSeq)) return empty;

  const totalBars = Math.max(0, endSeq - startSeq + 1);
  // 夹到 [1, totalBars]：脏数据（游标越界）不该让页面渲染出「第 -3 根」
  const cursorIndex = Math.min(Math.max(1, cursorSeq - startSeq + 1), Math.max(1, totalBars));
  const finished = String(s.status || '').toUpperCase() === 'FINISHED';

  if (finished) {
    return {
      ...empty,
      sessionId: s.id ?? null,
      reason: '上一次训练已结束',
      totalBars,
      cursorIndex,
    };
  }

  return {
    resumable: true,
    sessionId: s.id ?? null,
    alias: s.alias || null,
    status: s.status || 'RUNNING',
    cursorIndex,
    totalBars,
    percent: totalBars > 0 ? Math.round((cursorIndex / totalBars) * 100) : 0,
    // 验收标准原文口径：「上次停在第 N 根」
    text: `上次停在第 ${cursorIndex} 根（共 ${totalBars} 根），可以继续。`,
    updatedAt: s.last_active_at || s.created_at || null,
    actions: {
      resume: { label: '继续训练', path: `/blind?session=${s.id ?? ''}` },
      abandon: { label: '放弃这段', path: `/blind?abandon=${s.id ?? ''}` },
    },
  };
}

/** 取当前用户最近一个未结束的会话（断点续做的取数入口） */
export async function findResumableSession(userId) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 1);
  const { rows } = await pool.query(
    `SELECT * FROM blind_sessions
      WHERE ${w.sql} AND status='RUNNING'
      ORDER BY COALESCE(last_active_at, created_at) DESC
      LIMIT 1`,
    w.params
  );
  return rows.length > 0 ? rows[0] : null;
}

/** 断点续做：返回可直接渲染的会话 + 提示；没有可续做的内容时 resumable=false */
export async function resumeBlind(userId) {
  const s = await findResumableSession(userId);
  if (!s) return { resumable: false, hint: buildResumeHint(null), session: null, view: null, bars: null };
  const r = await getBlindSession(userId, s.id);
  return {
    resumable: true,
    hint: buildResumeHint(s),
    session: toResumeDto(s),
    view: r ? r.view : null,
    bars: r ? r.maskedBars : null,
  };
}

/** 放弃这段训练：标记为 ABANDONED，之后的续做查询不再命中它 */
export async function abandonBlind(userId, sessionId) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(
    `UPDATE blind_sessions SET status='ABANDONED', last_active_at=now()
      WHERE id=$1 AND ${w.sql} AND status='RUNNING' RETURNING *`,
    [sessionId, ...w.params]
  );
  return rows.length > 0 ? rows[0] : null;
}

/** 续做接口返回的会话 DTO：与 toSessionDto 同口径，未结束不暴露身份 */
function toResumeDto(s) {
  return {
    id: s.id,
    alias: s.alias,
    status: s.status,
    code: null,
    name: null,
    startSeq: null,
    endSeq: null,
    cursorSeq: null,
    totalBars: s.end_seq - s.start_seq + 1,
    cursorIndex: s.cursor_seq - s.start_seq + 1,
    score: s.score,
    createdAt: s.created_at,
    finishedAt: s.finished_at,
    segmentTag: s.segment_tag || null,
    segmentTagLabel: s.segment_tag ? SEGMENT_TAGS[s.segment_tag]?.label || null : null,
    granularity: s.granularity || DEFAULT_GRANULARITY,
  };
}

/**
 * 刷新会话活跃时间（推进 / 决策 / 下单都会调用）。
 * 「上次停在第 N 根」要准，靠的就是这个时间戳而不是 created_at。
 */
async function touchSession(sessionId) {
  await pool.query('UPDATE blind_sessions SET last_active_at=now() WHERE id=$1', [sessionId]);
}

/* ------------------------------------------------------------------ *
 * RQ-38 强制决策记录                                                  *
 * ------------------------------------------------------------------ */

export async function recordDecision({ userId, guestToken = null, sessionId, action, reason, stopPlan, skipped = false }) {
  const own = identityOf({ userId, guestToken });
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(`SELECT * FROM blind_sessions WHERE id=$1 AND ${w.sql}`, [sessionId, ...w.params]);
  if (rows.length === 0) return null;
  const s = rows[0];
  if (s.status === 'FINISHED') throw blindError('该训练已结束，无法再记录决策', 400);

  const act = String(action || '').toUpperCase();
  if (!['BUY', 'SELL', 'HOLD'].includes(act)) throw blindError('决策方向需为 买/卖/观望', 400);

  const text = typeof reason === 'string' ? reason.trim() : '';
  const isSkipped = Boolean(skipped) || text.length === 0;

  // 计划止损必须为正数且不超过合理区间，否则与「没写」等价
  let stop = Number(stopPlan);
  if (!Number.isFinite(stop) || stop <= 0) stop = null;

  const { rows: ins } = await pool.query(
    `INSERT INTO blind_decisions (session_id, seq, action, reason, stop_plan, skipped)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [s.id, s.cursor_seq, act, text || null, stop, isSkipped]
  );
  await touchSession(s.id);
  logger.info('双盲决策已记录', { userId, sessionId, seq: s.cursor_seq, action: act, skipped: isSkipped });
  return { id: ins[0].id, skipped: isSkipped };
}

export async function listDecisions(sessionId) {
  const { rows } = await pool.query(
    'SELECT id, seq, action, reason, stop_plan, skipped, created_at FROM blind_decisions WHERE session_id=$1 ORDER BY seq ASC, id ASC',
    [sessionId]
  );
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    action: r.action,
    reason: r.reason,
    stopPlan: r.stop_plan === null ? null : Number(r.stop_plan),
    skipped: Boolean(r.skipped),
    createdAt: r.created_at,
  }));
}

/**
 * 对外的决策列表：训练中把 seq 折算成相对序号。
 * 直接透出真实 seq 的话，拿训练 ID 调这个接口就能把「第几根」对回交易日历（RQ-66）。
 */
export async function listBlindDecisions(userId, sessionId) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(
    `SELECT id, start_seq, status FROM blind_sessions WHERE id=$1 AND ${w.sql}`,
    [sessionId, ...w.params]
  );
  if (rows.length === 0) return null;
  const s = rows[0];
  const reveal = s.status === 'FINISHED';
  return (await listDecisions(s.id)).map((d) => ({
    ...d,
    seq: reveal ? d.seq : d.seq - s.start_seq + 1,
  }));
}

/* ------------------------------------------------------------------ *
 * RQ-41 成绩（含纪律执行率）                                          *
 * ------------------------------------------------------------------ */

/** 由 simulateReplay 结果 + 决策记录构建成绩单（纯函数，便于单测） */
export function buildBlindScore({ state, decisions = [], startedAt, finishedAt, initialCapital = DEFAULT_CAPITAL } = {}) {
  // 默认参数兜不住显式 null：成绩页是只读展示，入参残缺时降级为空态而不是 500
  const st = state && typeof state === 'object' ? state : {};
  const disc = disciplineRate(Array.isArray(decisions) ? decisions : []);
  // 口径与 replayService 一致：总资产 = 现金 + 持仓市值，由模拟内核给出
  const totalAssets = round2(Number(st.totalAssets ?? st.cash ?? 0));
  const returnPct = initialCapital > 0 ? pct2(((totalAssets - initialCapital) / initialCapital) * 100) : 0;
  const durationSec =
    startedAt && finishedAt
      ? Math.max(0, Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000))
      : null;

  return {
    // 核心成绩五项 + 纪律执行率（RQ-41）
    returnPct,
    totalAssets,
    maxDrawdown: st.maxDrawdown ?? 0,
    tradeCount: st.tradeCount ?? 0,
    durationSec,
    decisionPoints: disc.total,
    disciplineRate: disc.rate,
    discipline: disc,
    // RQ-77：单次训练的样本远小于 50 笔，这里明确不给结论性判断
    sampleNote:
      (st.tradeCount ?? 0) < SAMPLE_THRESHOLD
        ? `本次训练 ${st.tradeCount ?? 0} 笔，未达 ${SAMPLE_THRESHOLD} 笔可信门槛，成绩仅反映本次片段，不构成能力结论。`
        : '样本已足够，可进入交易体检单查看跨会话结论。',
    realizedTotal: round2(st.realizedTotal || 0),
    feeTotal: round2(st.feeTotal || 0),
    disclaimer: '模拟训练成绩基于真实历史行情，不构成投资建议，不承诺任何收益。',
  };
}

export async function finishBlind(userId, sessionId) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(`SELECT * FROM blind_sessions WHERE id=$1 AND ${w.sql}`, [sessionId, ...w.params]);
  if (rows.length === 0) return null;
  const s = rows[0];
  if (s.status === 'FINISHED') {
    return getBlindSession(userId, s.id, { reveal: true });
  }

  const [bars, orders] = await Promise.all([loadBars(s.start_seq, s.end_seq, s.stock_code), loadOrders(s.id)]);
  const state = simulateReplay({
    initialCapital: Number(s.initial_capital),
    bars,
    orders,
    uptoSeq: s.end_seq,
    stockMeta: await loadMeta([s.stock_code]),
  });
  const decisions = await listDecisions(s.id);
  const score = buildBlindScore({
    state,
    decisions,
    startedAt: s.created_at,
    finishedAt: new Date().toISOString(),
    initialCapital: Number(s.initial_capital),
  });

  await pool.query(
    "UPDATE blind_sessions SET status='FINISHED', cursor_seq=$1, score=$2, finished_at=now() WHERE id=$3",
    [s.end_seq, JSON.stringify(score), s.id]
  );
  logger.info('双盲训练结束', { userId, sessionId, returnPct: score.returnPct, disciplineRate: score.disciplineRate });
  return getBlindSession(userId, s.id, { reveal: true });
}

/** 在盲测片段内下单（只写 blind_orders，绝不触碰真实账户，RQ-42） */
export async function tradeInBlind({ userId, guestToken = null, sessionId, side, quantity }) {
  const own = identityOf({ userId, guestToken });
  const w = ownerWhere(own, 2);
  const { rows } = await pool.query(`SELECT * FROM blind_sessions WHERE id=$1 AND ${w.sql}`, [sessionId, ...w.params]);
  if (rows.length === 0) return null;
  const s = rows[0];
  if (s.status === 'FINISHED') throw blindError('该训练已结束', 400);
  const sd = String(side || '').toUpperCase();
  const q = Number(quantity);
  if (!['BUY', 'SELL'].includes(sd)) throw blindError('方向错误', 400);
  if (!Number.isInteger(q) || q <= 0) throw blindError('数量需为正整数', 400);
  if (q % 100 !== 0) throw blindError('委托数量需为 100 的整数倍', 400);

  const bars = await loadBars(s.start_seq, s.end_seq, s.stock_code);
  const orders = await loadOrders(s.id);
  const trial = simulateReplay({
    initialCapital: Number(s.initial_capital),
    bars,
    orders: [...orders, { seq: s.cursor_seq, code: s.stock_code, side: sd, quantity: q }],
    uptoSeq: s.cursor_seq,
    stockMeta: await loadMeta([s.stock_code]),
  });
  const rej = trial.rejected.filter((r) => r.seq === s.cursor_seq);
  if (rej.length > 0) throw blindError(rej[rej.length - 1].reason, 400);

  const exec = trial.trades.filter((t) => t.seq === s.cursor_seq).pop();
  const bar = bars.find((b) => b.seq === s.cursor_seq);
  const p = bar?.prices?.[s.stock_code]?.close ?? 0;
  await pool.query(
    `INSERT INTO blind_orders (session_id, seq, stock_code, stock_name, side, quantity, price, amount, fee, realized_pnl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [s.id, s.cursor_seq, s.stock_code, s.stock_name, sd, q, p, round2(p * q), exec ? exec.fee : 0, exec ? exec.realizedPnl : 0]
  );
  await touchSession(s.id);
  return getBlindSession(userId, s.id);
}

export async function listBlindSessions(userId, limit = 20) {
  const own = asIdentity(userId);
  const w = ownerWhere(own, 1);
  const { rows } = await pool.query(
    `SELECT id, alias, stock_code, stock_name, start_seq, end_seq, status, score, created_at, finished_at,
            segment_tag, granularity, prescription_key, preset
       FROM blind_sessions WHERE ${w.sql} ORDER BY created_at DESC LIMIT $${w.nextIndex}`,
    [...w.params, clampLimit(limit, 100, 20)]
  );
  return rows.map((r) => ({
    id: r.id,
    alias: r.alias,
    // 列表在未结束时同样不暴露身份；结束后揭示（前端据此展示对照）
    code: r.status === 'FINISHED' ? r.stock_code : null,
    name: r.status === 'FINISHED' ? r.stock_name : null,
    status: r.status,
    startSeq: r.start_seq,
    endSeq: r.end_seq,
    score: r.score,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    // RQ-82 特征标签是统计口径不是身份信息，可以展示
    segmentTag: r.segment_tag || null,
    segmentTagLabel: r.segment_tag ? SEGMENT_TAGS[r.segment_tag]?.label || null : null,
    // RQ-81 粒度明示
    granularity: r.granularity || DEFAULT_GRANULARITY,
    prescriptionKey: r.prescription_key || null,
    // RQ-107 局长度档位
    preset: r.preset || 'standard',
  }));
}

// 注意：SEGMENT_TAGS / GRANULARITIES / classifySegment 等已在定义处用 export 声明，
// 此处只导出原本未导出的常量，重复 export 同名标识符会直接抛 SyntaxError 导致整个模块加载失败。
export { DEFAULT_BARS, MIN_BARS, MAX_BARS, buildCheckup, buildPrescription };
