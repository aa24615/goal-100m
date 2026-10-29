// 行情时间机器：回放训练服务（RQ-01 ~ RQ-06）
//
// 设计原则
// 1) 可复现（RQ-01/02）：状态完全由 (初始资金 + bars + 成交流水 + cursor) 确定性推导，
//    不做任何增量累加 —— 因此「倒带」到任意 bar 都能得到与历史完全一致的结果。
// 2) 规则一致（RQ-03）：复用与实时盘同一个 calcFees / 涨跌停 / 报价保护 / T+1 语义，
//    保证同一操作在回放与实时盘下资金、持仓、盈亏计算口径一致。
// 3) 完全隔离（RQ-06）：回放只用 replay_* 表，绝不写 users / holdings / transactions，
//    因此不会污染真实账户余额、持仓与排行榜。

import pool from '../db.js';
import { logger } from '../logger.js';
import { calcFees } from '../fees.js';
import { priceLimitOf } from '../rules.js';
import { clampLimit } from '../utils/num.js';

const DEFAULT_CAPITAL = 1000000;
const MAX_RANGE_BARS = 400; // 单次回放最多允许的 bar 数，防止超大数据量拖垮查询（RK-03）
const MIN_RANGE_BARS = 2;

export const round2 = (n) => Math.round(n * 100) / 100;
const pct2 = (n) => Math.round(n * 100) / 100;
// 成本价精度必须与 executeTrade 完全一致：实时盘用 4 位小数（*10000/10000），
// 若这里退化为 2 位，同一笔买卖在回放与实时盘下会差出几个基点，直接违反 RQ-03。
const round4 = (n) => Math.round(n * 10000) / 10000;

export function replayError(message, status, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra || {};
  e.expose = true;
  // 标记为业务规则拒绝：否则 errorHandler 会把「T+1 冻结」「委托数量需为整手」
  // 这类正常业务拒绝记成「请求报文非法(4xx)」，与真正的报文解析失败混在一起，
  // 让日志无法区分「用户操作被规则挡下」和「接口契约被破坏」。
  e.business = true;
  return e;
}

/* ------------------------------------------------------------------ *
 * 纯计算核心：不依赖 DB，便于单元测试直接驱动                        *
 * ------------------------------------------------------------------ */

/**
 * 按 bar 序列重演成交流水，得到任意 cursor 处的完整账户状态。
 *
 * @param {object}   opts
 * @param {number}   opts.initialCapital 初始虚拟资金
 * @param {Array}    opts.bars  [{ seq, prices: { code: {open,high,low,close,prevClose} } }]
 * @param {Array}    opts.orders [{ seq, code, side, quantity }]（价格取当根 bar 收盘价）
 * @param {number=}  opts.uptoSeq 计算到第几个 bar（倒带即传入更小的 seq）
 * @param {object=}  opts.stockMeta { code: { name, listingDate } } —— RQ-49 分板块所需，
 *                   缺省时仍按代码前缀识别板块（ST 需名称，缺名称则按非 ST 处理）
 */
export function simulateReplay({
  initialCapital = DEFAULT_CAPITAL,
  bars = [],
  orders = [],
  uptoSeq = null,
  stockMeta = {},
} = {}) {
  const bySeq = new Map();
  for (const b of bars) bySeq.set(b.seq, b);
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  const lastSeq = uptoSeq == null ? (seqs.length > 0 ? seqs[seqs.length - 1] : 0) : uptoSeq;

  const ordersBySeq = new Map();
  for (const o of orders) {
    const arr = ordersBySeq.get(o.seq) || [];
    arr.push(o);
    ordersBySeq.set(o.seq, arr);
  }

  let cash = initialCapital;
  let realizedTotal = 0;
  let feeTotal = 0;
  let tradeCount = 0;
  const lots = []; // { seq, code, qty, remain, avgCost }
  const trades = []; // 逐笔成交（含已实现盈亏），供成绩与复盘复用
  const rejected = []; // 被规则拒绝的操作（资金不足 / T+1 / 涨跌停）
  const equity = [];

  let peak = initialCapital;
  let maxDrawdown = 0;

  const priceOf = (bar, code) => bar?.prices?.[code]?.close;

  for (const seq of seqs) {
    if (seq > lastSeq) break;
    const bar = bySeq.get(seq);

    for (const o of ordersBySeq.get(seq) || []) {
      const code = String(o.code || '').toUpperCase();
      const p = priceOf(bar, code);
      if (p == null) {
        rejected.push({ seq, code, side: o.side, quantity: o.quantity, reason: '该标的在回放区间内无行情' });
        continue;
      }
      const prevClose = Number(bar.prices[code]?.prevClose ?? p);
      // RQ-49：回放里的涨跌停按板块生效（创/科 ±20%、北交所 ±30%、主板 ST ±5%），
      // 而不是全市场一刀切 ±10% —— 否则「回放规则一致」这条 RQ-03 是假的。
      const meta = stockMeta[code] || {};
      const lim = priceLimitOf(code, meta.name, prevClose, meta.listingDate);
      const limitUp = lim.limitUp;
      const limitDown = lim.limitDown;
      const qty = Number(o.quantity);

      // 零成交（停牌日）的 bar 不参与撮合，RQ-50
      const barVolume = Number(bar.prices[code]?.volume);
      if (Number.isFinite(barVolume) && barVolume === 0) {
        rejected.push({ seq, code, side: o.side, quantity: qty, reason: '该交易日零成交（停牌），不可交易' });
        continue;
      }

      if (o.side === 'BUY') {
        // 与实时盘同一套涨跌停约束：涨停买单不可成交
        // limitUp 为 null 表示无涨跌幅限制（新股/昨收缺失），必须跳过而非「>= 0 恒真」
        if (Number.isFinite(limitUp) && p >= limitUp * 0.999) {
          rejected.push({ seq, code, side: 'BUY', quantity: qty, reason: '已涨停，买单无法成交' });
          continue;
        }
        const amount = round2(p * qty);
        const fee = calcFees(amount, 'BUY');
        const total = round2(amount + fee);
        if (total > cash) {
          rejected.push({ seq, code, side: 'BUY', quantity: qty, reason: '可用资金不足' });
          continue;
        }
        cash = round2(cash - total);
        lots.push({ seq, code, qty, remain: qty, avgCost: round4(total / qty) });
        feeTotal = round2(feeTotal + fee);
        tradeCount += 1;
        trades.push({ seq, code, side: 'BUY', quantity: qty, price: p, amount, fee, realizedPnl: 0 });
      } else {
        if (Number.isFinite(limitDown) && p <= limitDown * 1.001) {
          rejected.push({ seq, code, side: 'SELL', quantity: qty, reason: '已跌停，卖单无法成交' });
          continue;
        }
        // T+1：回放世界里「一个 bar = 一个交易日」，只有 seq 严格小于当前 bar 的批次可卖
        const sellableLots = lots.filter((l) => l.code === code && l.remain > 0 && l.seq < seq);
        const sellable = sellableLots.reduce((s, l) => s + l.remain, 0);
        if (qty > sellable) {
          rejected.push({
            seq,
            code,
            side: 'SELL',
            quantity: qty,
            reason: `T+1 冻结，当前可卖 ${sellable} 股`,
          });
          continue;
        }
        let left = qty;
        let costBasis = 0;
        for (const l of sellableLots) {
          if (left <= 0) break;
          const take = Math.min(left, l.remain);
          costBasis = round2(costBasis + take * l.avgCost);
          l.remain -= take;
          left -= take;
        }
        const amount = round2(p * qty);
        const fee = calcFees(amount, 'SELL');
        const avgCost = qty > 0 ? costBasis / qty : 0;
        const realized = round2((p - avgCost) * qty - fee);
        cash = round2(cash + amount - fee);
        realizedTotal = round2(realizedTotal + realized);
        feeTotal = round2(feeTotal + fee);
        tradeCount += 1;
        trades.push({ seq, code, side: 'SELL', quantity: qty, price: p, amount, fee, realizedPnl: realized });
      }
    }

    // 逐 bar 盯市：持仓按当根收盘价估值，用于净值序列与最大回撤
    let marketValue = 0;
    const agg = new Map(); // code -> { qty, cost, mv, sellable }
    for (const l of lots) {
      if (l.remain <= 0) continue;
      const close = priceOf(bar, l.code) ?? l.avgCost;
      marketValue = round2(marketValue + l.remain * close);
      const a = agg.get(l.code) || { qty: 0, cost: 0, mv: 0, sellable: 0 };
      a.qty += l.remain;
      a.cost = round2(a.cost + l.remain * l.avgCost);
      a.mv = round2(a.mv + l.remain * close);
      if (l.seq < seq) a.sellable += l.remain;
      agg.set(l.code, a);
    }
    const totalAssets = round2(cash + marketValue);
    if (totalAssets > peak) peak = totalAssets;
    if (peak > 0) {
      const dd = ((peak - totalAssets) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    equity.push({ seq, cash, marketValue, totalAssets });
  }

  // 末点状态（若 uptoSeq 超出 bars 范围，则以最后一根 bar 的价格估值）
  const lastBar = seqs.filter((s) => s <= lastSeq).length > 0 ? bySeq.get(seqs.filter((s) => s <= lastSeq).pop()) : null;
  const positions = [];
  let marketValue = 0;
  if (lastBar) {
    const agg = new Map();
    for (const l of lots) {
      if (l.remain <= 0) continue;
      const close = priceOf(lastBar, l.code) ?? l.avgCost;
      marketValue = round2(marketValue + l.remain * close);
      const a = agg.get(l.code) || { qty: 0, cost: 0, mv: 0, sellable: 0 };
      a.qty += l.remain;
      a.cost = round2(a.cost + l.remain * l.avgCost);
      a.mv = round2(a.mv + l.remain * close);
      if (l.seq < (lastSeq ?? 0) || l.seq <= lastSeq - 1) a.sellable += l.remain;
      agg.set(l.code, a);
    }
    for (const [code, a] of agg) {
      positions.push({
        code,
        quantity: a.qty,
        sellable: a.sellable,
        avgCost: a.qty > 0 ? round2(a.cost / a.qty) : 0,
        price: priceOf(lastBar, code) ?? 0,
        marketValue: a.mv,
        pnl: round2(a.mv - a.cost),
        pnlPct: a.cost > 0 ? pct2(((a.mv - a.cost) / a.cost) * 100) : 0,
      });
    }
  }
  const totalAssets = round2(cash + marketValue);

  return {
    cash,
    marketValue,
    totalAssets,
    realizedTotal,
    feeTotal,
    tradeCount,
    returnPct: initialCapital > 0 ? pct2(((totalAssets - initialCapital) / initialCapital) * 100) : 0,
    maxDrawdown: pct2(maxDrawdown),
    positions: positions.sort((a, b) => b.marketValue - a.marketValue),
    equity,
    trades,
    rejected,
    lots: lots.filter((l) => l.remain > 0).map((l) => ({ seq: l.seq, code: l.code, quantity: l.remain, avgCost: l.avgCost })),
  };
}

/** 训练成绩（RQ-04）：收益、最大回撤、交易次数、用时 —— 口径与实时盘一致 */
export function buildScore({ initialCapital, totalAssets, maxDrawdown, tradeCount, durationSec }) {
  return {
    initialCapital: round2(initialCapital),
    finalAssets: round2(totalAssets),
    profit: round2(totalAssets - initialCapital),
    returnPct: initialCapital > 0 ? pct2(((totalAssets - initialCapital) / initialCapital) * 100) : 0,
    maxDrawdown: pct2(maxDrawdown),
    tradeCount: Number(tradeCount) || 0,
    durationSec: Number(durationSec) || 0,
  };
}

/* ------------------------------------------------------------------ *
 * DB 层：会话与流水                                                   *
 * ------------------------------------------------------------------ */

/** 已积累的可回放区间（RQ-01：可选区间覆盖全部已积累交易日） */
export async function getReplayRange() {
  const { rows } = await pool.query(
    `SELECT MIN(seq)::int AS "minSeq", MAX(seq)::int AS "maxSeq", COUNT(DISTINCT seq)::int AS "barCount"
       FROM stock_daily`
  );
  const r = rows[0] || {};
  return {
    minSeq: r.minSeq ?? null,
    maxSeq: r.maxSeq ?? null,
    barCount: r.barCount ?? 0,
    maxBars: MAX_RANGE_BARS,
    hasData: Boolean(r.barCount),
  };
}

async function loadBars(startSeq, endSeq) {
  const { rows } = await pool.query(
    `SELECT seq, code, open, high, low, close, prev_close, volume
       FROM stock_daily
      WHERE seq BETWEEN $1 AND $2
      ORDER BY seq ASC`,
    [startSeq, endSeq]
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
      // RQ-50：零成交 bar = 停牌日，回放中不可交易
      volume: Number(r.volume || 0),
    };
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 标的元信息（名称 / 上市日期）—— RQ-49 分板块涨跌停需要：
 * 板块可由代码前缀判定，但 ST（±5%）与新股免涨跌幅只能靠名称与上市日期识别。
 */
async function loadStockMeta(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (list.length === 0) return {};
  const { rows } = await pool.query(
    'SELECT code, name, listing_date FROM stocks WHERE code = ANY($1::text[])',
    [list]
  );
  const meta = {};
  for (const r of rows) {
    meta[r.code] = {
      name: r.name,
      listingDate: r.listing_date ? String(r.listing_date).slice(0, 10) : null,
    };
  }
  return meta;
}

async function loadOrders(sessionId) {
  const { rows } = await pool.query(
    'SELECT seq, stock_code, stock_name, side, quantity, price FROM replay_orders WHERE session_id=$1 ORDER BY seq ASC, id ASC',
    [sessionId]
  );
  return rows.map((r) => ({
    seq: r.seq,
    code: r.stock_code,
    name: r.stock_name,
    side: r.side,
    quantity: r.quantity,
    price: Number(r.price),
  }));
}

/** 由 DB 重建任意 cursor 处的状态（倒带 / 恢复会话都走这里，保证一致） */
export async function rebuildState(session, uptoSeq) {
  const bars = await loadBars(session.start_seq, session.end_seq);
  const orders = await loadOrders(session.id);
  const cursor = uptoSeq ?? session.cursor_seq;
  const metaCodes = [...bars.flatMap((b) => Object.keys(b.prices)), ...orders.map((o) => o.code)];
  const state = simulateReplay({
    initialCapital: Number(session.initial_capital),
    bars,
    orders,
    uptoSeq: cursor,
    stockMeta: await loadStockMeta(metaCodes),
  });
  state.cursorSeq = cursor;
  state.startSeq = session.start_seq;
  state.endSeq = session.end_seq;
  state.status = session.status;
  return state;
}

async function persistState(session, state) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM replay_positions WHERE session_id=$1', [session.id]);
    await client.query('DELETE FROM replay_lots WHERE session_id=$1', [session.id]);
    for (const p of state.positions) {
      await client.query(
        'INSERT INTO replay_positions (session_id, stock_code, quantity, avg_cost) VALUES ($1,$2,$3,$4)',
        [session.id, p.code, p.quantity, p.avgCost]
      );
    }
    for (const l of state.lots) {
      await client.query(
        'INSERT INTO replay_lots (session_id, stock_code, seq, quantity, remain, avg_cost) VALUES ($1,$2,$3,$4,$5,$6)',
        [session.id, l.code, l.seq, l.quantity, l.quantity, l.avgCost]
      );
    }
    // 净值序列：整段覆盖写，倒带后被裁掉的部分自然失效
    await client.query('DELETE FROM replay_equity WHERE session_id=$1', [session.id]);
    for (const e of state.equity) {
      await client.query(
        'INSERT INTO replay_equity (session_id, seq, cash, market_value, total_assets) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, seq) DO NOTHING',
        [session.id, e.seq, e.cash, e.marketValue, e.totalAssets]
      );
    }
    await client.query('UPDATE replay_sessions SET cursor_seq=$1 WHERE id=$2', [state.cursorSeq, session.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getSession(sessionId, userId) {
  const { rows } = await pool.query('SELECT * FROM replay_sessions WHERE id=$1 AND user_id=$2', [
    sessionId,
    userId,
  ]);
  if (!rows[0]) throw replayError('回放会话不存在', 404);
  return rows[0];
}

/** 创建回放会话（RQ-01 / RQ-05：同一区间可反复创建，历史成绩不覆盖） */
export async function startSession({ userId, startSeq, endSeq, capital }) {
  const range = await getReplayRange();
  if (!range.hasData) throw replayError('暂无可回放的历史行情', 400);

  const s = Number(startSeq);
  const e = Number(endSeq);
  if (!Number.isInteger(s) || !Number.isInteger(e)) throw replayError('区间参数错误', 400);
  if (s < range.minSeq || e > range.maxSeq) {
    throw replayError(`可选区间为第 ${range.minSeq} ~ ${range.maxSeq} 个交易日`, 400);
  }
  if (e <= s) throw replayError('结束交易日必须晚于起始交易日', 400);
  if (e - s + 1 < MIN_RANGE_BARS) throw replayError('回放区间至少需要 2 个交易日', 400);
  if (e - s + 1 > MAX_RANGE_BARS) {
    throw replayError(`单次回放最多 ${MAX_RANGE_BARS} 个交易日`, 400);
  }

  const init = Number(capital) > 0 ? Number(capital) : DEFAULT_CAPITAL;
  const { rows } = await pool.query(
    `INSERT INTO replay_sessions (user_id, start_seq, end_seq, cursor_seq, initial_capital)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, s, e, s, init]
  );
  logger.info('回放训练已开始', { userId, sessionId: rows[0].id, startSeq: s, endSeq: e });
  const state = await rebuildState(rows[0], s);
  await persistState(rows[0], state);
  return { session: publicSession(rows[0]), state };
}

function publicSession(s) {
  return {
    id: Number(s.id),
    startSeq: s.start_seq,
    endSeq: s.end_seq,
    cursorSeq: s.cursor_seq,
    initialCapital: Number(s.initial_capital),
    status: s.status,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
    result: s.result,
    durationSec: s.duration_sec,
  };
}

/**
 * 推进 / 回退 / 定位（RQ-02：倍速、暂停、单步、倒带）
 * 倍速与暂停由前端播放器控制节奏，服务端只保证「给定 cursor 的状态唯一且可复现」。
 */
export async function stepSession({ userId, sessionId, action, seq }) {
  const session = await getSession(sessionId, userId);
  if (session.status !== 'RUNNING') throw replayError('回放已结束', 400);

  let next = session.cursor_seq;
  if (action === 'next') next = session.cursor_seq + 1;
  else if (action === 'prev') next = session.cursor_seq - 1;
  else if (action === 'seek') next = Number(seq);
  else if (action === 'hold') next = session.cursor_seq;
  else throw replayError('不支持的操作', 400);

  if (!Number.isInteger(next)) throw replayError('目标位置无效', 400);
  next = Math.max(session.start_seq, Math.min(session.end_seq, next));

  const state = await rebuildState(session, next);
  await persistState(session, state);
  return { session: publicSession({ ...session, cursor_seq: next }), state, atEnd: next >= session.end_seq };
}

/** 回放中下单（RQ-03 / RQ-06） */
export async function tradeInReplay({ userId, sessionId, code, side, quantity }) {
  const session = await getSession(sessionId, userId);
  if (session.status !== 'RUNNING') throw replayError('回放已结束，无法继续交易', 400);

  const c = String(code || '').toUpperCase();
  const s = String(side || '').toUpperCase();
  const q = Number(quantity);
  if (!c || !['BUY', 'SELL'].includes(s)) throw replayError('参数错误', 400);
  if (!Number.isInteger(q) || q <= 0) throw replayError('数量需为正整数', 400);
  if (q % 100 !== 0) throw replayError('委托数量需为 100 的整数倍', 400);

  const bars = await loadBars(session.cursor_seq, session.cursor_seq);
  if (bars.length === 0) throw replayError('当前位置无行情数据', 400);
  const bar = bars[0];
  const p = bar.prices[c];
  if (!p) throw replayError('该标的在当前回放区间无行情', 404);

  // 先用「试算」验证规则是否放行：未通过的写入 rejected，不落流水
  const orders = await loadOrders(session.id);
  const fullBars = await loadBars(session.start_seq, session.end_seq);
  const metaCodes = [...fullBars.flatMap((b) => Object.keys(b.prices)), ...orders.map((o) => o.code), c];
  const trial = simulateReplay({
    initialCapital: Number(session.initial_capital),
    bars: fullBars,
    orders: [...orders, { seq: session.cursor_seq, code: c, side: s, quantity: q }],
    uptoSeq: session.cursor_seq,
    stockMeta: await loadStockMeta(metaCodes),
  });
  const rejectedHere = trial.rejected.filter((r) => r.seq === session.cursor_seq);
  if (rejectedHere.length > 0) {
    // 列表中最后一条即本次操作对应的拒绝原因
    throw replayError(rejectedHere[rejectedHere.length - 1].reason, 400);
  }

  // 取本次成交的实际金额与费用落流水（与试算同源，口径一致）
  const executed = trial.trades.filter((t) => t.seq === session.cursor_seq).pop();
  const amount = round2(p.close * q);
  const fee = calcFees(amount, s);
  await pool.query(
    `INSERT INTO replay_orders (session_id, stock_code, stock_name, side, quantity, price, amount, fee, realized_pnl, seq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [session.id, c, c, s, q, p.close, amount, fee, executed ? executed.realizedPnl : 0, session.cursor_seq]
  );

  const state = await rebuildState(session, session.cursor_seq);
  await persistState(session, state);
  logger.info('回放训练下单', { userId, sessionId, code: c, side: s, quantity: q, price: p.close });
  return { ok: true, price: p.close, state };
}

/** 结束回放并生成成绩（RQ-04） */
export async function finishSession({ userId, sessionId }) {
  const session = await getSession(sessionId, userId);
  if (session.status === 'FINISHED' && session.result) {
    return { session: publicSession(session), state: null, score: session.result };
  }
  const state = await rebuildState(session, session.end_seq);
  const durationSec = Math.max(1, Math.round((Date.now() - new Date(session.started_at).getTime()) / 1000));
  const score = buildScore({
    initialCapital: Number(session.initial_capital),
    totalAssets: state.totalAssets,
    maxDrawdown: state.maxDrawdown,
    tradeCount: state.tradeCount,
    durationSec,
  });
  await pool.query(
    `UPDATE replay_sessions SET status='FINISHED', finished_at=now(), duration_sec=$1, result=$2, cursor_seq=$3 WHERE id=$4`,
    [durationSec, JSON.stringify(score), session.end_seq, session.id]
  );
  logger.info('回放训练已结束', { userId, sessionId, ...score });
  return { session: publicSession({ ...session, status: 'FINISHED', result: score, duration_sec: durationSec }), state, score };
}

/** 历史成绩列表（RQ-05：同一用户多次成绩均可查询，不被覆盖） */
export async function listSessions(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM replay_sessions WHERE user_id=$1 ORDER BY started_at DESC LIMIT $2`,
    // clampLimit 而非只夹上限：原写法 `Math.max(1, Number(limit) || 20)` 不做取整，
    // `?limit=1.5` 会原样进 SQL 的 LIMIT（该参数在 PG 侧是 bigint），抛
    // 22P02「invalid input syntax for type bigint: "1.5"」并被兜成 500。
    // 口径与 blindService.listBlindSessions 一致：[1,100]，缺省 20。
    [userId, clampLimit(limit, 100, 20)]
  );
  return rows.map(publicSession);
}

/** 同一区间的多次成绩对比（RQ-05） */
export async function compareSessions({ userId, startSeq, endSeq }) {
  const { rows } = await pool.query(
    `SELECT * FROM replay_sessions
      WHERE user_id=$1 AND start_seq=$2 AND end_seq=$3 AND status='FINISHED'
      ORDER BY started_at ASC`,
    [userId, Number(startSeq), Number(endSeq)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    startedAt: r.started_at,
    durationSec: r.duration_sec,
    result: r.result,
  }));
}

export async function getSessionState({ userId, sessionId }) {
  const session = await getSession(sessionId, userId);
  const state = await rebuildState(session, session.cursor_seq);
  return { session: publicSession(session), state };
}

export { DEFAULT_CAPITAL, MAX_RANGE_BARS };
