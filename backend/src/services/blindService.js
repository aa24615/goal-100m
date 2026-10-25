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
import { buildCheckup, disciplineRate, SAMPLE_THRESHOLD } from './checkupService.js';
import { round2, pct2 } from '../utils/time.js';

const DEFAULT_CAPITAL = 1000000;
/** 盲测片段长度（根 K 线） */
const DEFAULT_BARS = 60;
const MIN_BARS = 20;
const MAX_BARS = 200;
/** 每 N 根 K 线要求记录一次决策（RQ-38） */
export const DECISION_INTERVAL = 10;
/** 「有流动性」的门槛：区间内日均成交额（元），低于此值的标的不进入随机池 */
const MIN_AVG_AMOUNT = 5_000_000;

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
export async function pickRandomSegment({ bars = DEFAULT_BARS, liquidOnly = true } = {}) {
  const n = clampBars(bars);

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
    return chooseSegment(all, n);
  }
  return chooseSegment(candidates, n);
}

function chooseSegment(candidates, n) {
  // 均匀随机：先随机标的，再在其可用起点范围内随机起点
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const c = candidates[Math.floor(Math.random() * candidates.length)];
    const lo = c.minseq;
    const hi = c.maxseq - n + 1;
    if (hi < lo) continue;
    const start = lo + Math.floor(Math.random() * (hi - lo + 1));
    return { code: c.code, name: c.name, startSeq: start, endSeq: start + n - 1, bars: n };
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
 * @param {object} o { userId, bars, liquidOnly, code, startSeq, endSeq }
 *   指定 code/startSeq/endSeq 时走「定向片段」；否则随机（RQ-67）。
 */
export async function startBlind({ userId, bars, liquidOnly = true, code, startSeq, endSeq } = {}) {
  let seg;
  if (code && Number.isInteger(Number(startSeq)) && Number.isInteger(Number(endSeq))) {
    seg = { code: String(code).toUpperCase(), name: '', startSeq: Number(startSeq), endSeq: Number(endSeq) };
    const { rows } = await pool.query('SELECT name FROM stocks WHERE code=$1', [seg.code]);
    if (rows.length === 0) throw blindError('标的不存在', 404);
    seg.name = rows[0].name;
  } else {
    seg = await pickRandomSegment({ bars, liquidOnly });
  }
  const n = clampBars(bars);
  if (seg.endSeq - seg.startSeq + 1 < MIN_BARS) throw blindError('片段长度不足', 400);

  const { rows } = await pool.query(
    `INSERT INTO blind_sessions
       (user_id, stock_code, stock_name, alias, start_seq, end_seq, cursor_seq, initial_capital, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING') RETURNING *`,
    [userId, seg.code, seg.name, makeAlias(Date.now() ^ Math.floor(Math.random() * 0xffff)), seg.startSeq, seg.endSeq, seg.startSeq, DEFAULT_CAPITAL]
  );
  logger.info('双盲训练开始', { userId, sessionId: rows[0].id, code: seg.code, startSeq: seg.startSeq, endSeq: seg.endSeq, bars: n });
  return rows[0];
}

export async function getBlindSession(userId, sessionId, { reveal = false } = {}) {
  const { rows } = await pool.query('SELECT * FROM blind_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]);
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
  const { rows } = await pool.query('SELECT * FROM blind_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]);
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

  await pool.query('UPDATE blind_sessions SET cursor_seq=$1 WHERE id=$2', [next, s.id]);
  return getBlindSession(userId, s.id);
}

/* ------------------------------------------------------------------ *
 * RQ-38 强制决策记录                                                  *
 * ------------------------------------------------------------------ */

export async function recordDecision({ userId, sessionId, action, reason, stopPlan, skipped = false }) {
  const { rows } = await pool.query('SELECT * FROM blind_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]);
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
  const { rows } = await pool.query('SELECT id, start_seq, status FROM blind_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]);
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
  const { rows } = await pool.query('SELECT * FROM blind_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]);
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
export async function tradeInBlind({ userId, sessionId, side, quantity }) {
  const { rows } = await pool.query('SELECT * FROM blind_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]);
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
  return getBlindSession(userId, s.id);
}

export async function listBlindSessions(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, alias, stock_code, stock_name, start_seq, end_seq, status, score, created_at, finished_at
       FROM blind_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(100, Number(limit) || 20)]
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
  }));
}

export { DEFAULT_BARS, MIN_BARS, MAX_BARS, buildCheckup };
