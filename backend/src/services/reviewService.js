// 复盘与战绩中心服务（RQ-07 ~ RQ-11）
//
// 纯计算部分（pairTrades / buildScorecard / composeReport）不依赖 DB，便于单测；
// 「AI 复盘报告」为**基于本人真实交易行为的规则诊断引擎**，不接外部大模型：
//   - 只做行为与统计层面的描述
//   - 不推荐任何标的、不预测行情、不承诺收益
//   - 报告显著位置携带免责声明（合规硬约束 RK-01）

import pool from '../db.js';
import { createHash } from 'node:crypto';
import { round2, pct2 } from '../utils/time.js';
import { buildCheckup } from './checkupService.js';

export const DISCLAIMER = '本报告基于你的模拟交易行为做统计诊断，仅用于学习复盘，不构成投资建议，不承诺任何收益。';

/* ------------------------------------------------------------------ *
 * RQ-07 买卖配对（FIFO 归因 + 与账户同口径的移动加权成本核算）        *
 * ------------------------------------------------------------------ */

/**
 * 把流水按标的配对成「一笔完整交易」。
 *
 * 成本核算刻意与 executeTrade 完全一致（移动加权平均，买入费用摊入成本），
 * 这样配对盈亏合计与账户 realized_pnl 总额严格相等（误差 ≤0.01 元）。
 * FIFO 只用于归因（这笔卖出对应哪几次买入、何时建仓），不参与盈亏金额计算。
 *
 * @param {Array} txs 流水（任意顺序，内部按时间升序处理）
 * @param {Record<string, number>} priceMap 当前市价（用于计算未平仓部分的浮动盈亏）
 */
export function pairTrades(txs = [], priceMap = {}) {
  const list = [...txs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const book = new Map();
  const rounds = [];
  let realizedSum = 0;
  let feeSum = 0;

  const slot = (t) => {
    let s = book.get(t.stockCode);
    if (!s) {
      s = {
        code: t.stockCode,
        name: t.stockName || t.stockCode,
        qty: 0,
        avgCost: 0,
        queue: [], // FIFO 买入批次
        openAt: null,
        buyQty: 0,
        buyAmount: 0,
        sellQty: 0,
        sellAmount: 0,
        feeCarry: 0, // 已支付但尚未归属到任何回合的买入费用
      };
      book.set(t.stockCode, s);
    }
    return s;
  };

  for (const t of list) {
    const s = slot(t);
    const qty = Number(t.quantity);
    const price = Number(t.price);
    const amount = Number(t.amount);
    const fee = Number(t.fee || 0);

    if (t.type === 'BUY') {
      const newQty = s.qty + qty;
      // 与 executeTrade 同口径：费用摊入成本
      s.avgCost = newQty > 0 ? (s.qty * s.avgCost + amount + fee) / newQty : 0;
      s.qty = newQty;
      s.buyQty += qty;
      s.buyAmount = round2(s.buyAmount + amount + fee);
      s.feeCarry = round2(s.feeCarry + fee); // 买入费用先挂账，随卖出/持仓归属
      feeSum = round2(feeSum + fee);
      if (!s.openAt) s.openAt = t.createdAt;
      s.queue.push({ id: t.id, ts: t.createdAt, qty, remaining: qty, price });
      continue;
    }

    // SELL
    if (s.qty <= 0) continue; // 数据异常（无持仓却卖出）：跳过，不产生配对
    // 按卖出比例把挂账的买入费用归属到本回合，保证「各回合费用之和 == 全部手续费」
    const ratio = s.qty > 0 ? Math.min(1, qty / s.qty) : 0;
    const attributedBuyFee = round2(s.feeCarry * ratio);
    s.feeCarry = round2(s.feeCarry - attributedBuyFee);
    const roundFee = round2(fee + attributedBuyFee);
    const costBasis = round2(Math.min(s.avgCost * qty, s.qty * s.avgCost));
    const realized = round2(price * qty - costBasis - fee);
    s.qty -= qty;
    s.sellQty += qty;
    s.sellAmount = round2(s.sellAmount + amount - fee);
    feeSum = round2(feeSum + fee);
    realizedSum = round2(realizedSum + realized);

    // FIFO 归因：这笔卖出消耗了哪些买入批次（用于持仓周期与归因展示）
    let left = qty;
    const legs = [];
    let openAt = null;
    while (left > 0 && s.queue.length > 0) {
      const lot = s.queue[0];
      const take = Math.min(left, lot.remaining);
      legs.push({ buyId: lot.id, buyPrice: lot.price, quantity: take, boughtAt: lot.ts });
      if (!openAt) openAt = lot.ts;
      lot.remaining -= take;
      left -= take;
      if (lot.remaining <= 0) s.queue.shift();
    }
    const closed = s.qty === 0;
    if (closed) {
      s.openAt = null;
      if (s.queue.length > 0) s.queue = [];
    }

    rounds.push({
      code: s.code,
      name: s.name,
      sellId: t.id,
      quantity: qty,
      buyPrice: legs.length > 0 ? round2(legs.reduce((a, l) => a + l.buyPrice * l.quantity, 0) / qty) : s.avgCost,
      sellPrice: price,
      avgCost: round2(s.avgCost),
      costBasis,
      proceeds: round2(amount - fee),
      fee: roundFee,
      realizedPnl: realized,
      returnPct: costBasis > 0 ? pct2((realized / costBasis) * 100) : 0,
      openedAt: openAt || t.createdAt,
      closedAt: t.createdAt,
      holdMs: openAt ? Math.max(0, new Date(t.createdAt) - new Date(openAt)) : 0,
      holdDays: openAt ? Math.round((new Date(t.createdAt) - new Date(openAt)) / 86400000) : 0,
      status: closed ? 'closed' : 'partial',
      legs,
    });
  }

  // 未平仓部分：展示为「持仓中」的一笔，体现浮动盈亏，不进吞吐量于已实现盈亏
  for (const s of book.values()) {
    if (s.qty <= 0) continue;
    const last = priceMap[s.code];
    rounds.push({
      code: s.code,
      name: s.name,
      sellId: null,
      quantity: s.qty,
      buyPrice: round2(s.avgCost),
      sellPrice: last == null ? null : last,
      avgCost: round2(s.avgCost),
      costBasis: round2(s.avgCost * s.qty),
      proceeds: null,
      fee: round2(s.feeCarry), // 未平仓部分承担的买入费用
      realizedPnl: 0,
      unrealizedPnl: last == null ? null : round2((last - s.avgCost) * s.qty),
      returnPct: last == null ? null : pct2(((last - s.avgCost) / s.avgCost) * 100),
      openedAt: s.openAt,
      closedAt: null,
      holdMs: s.openAt ? Math.max(0, Date.now() - new Date(s.openAt)) : 0,
      holdDays: s.openAt ? Math.round((Date.now() - new Date(s.openAt)) / 86400000) : 0,
      status: 'open',
      legs: [],
    });
  }

  rounds.sort((a, b) => new Date(b.closedAt || b.openedAt) - new Date(a.closedAt || a.openedAt));
  return { rounds, realizedSum, feeSum };
}

/* ------------------------------------------------------------------ *
 * RQ-08 周期战绩卡                                                    *
 * ------------------------------------------------------------------ */

export function maxDrawdownOf(series = []) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of series) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (n > peak) peak = n;
    if (peak > 0) {
      const dd = ((peak - n) / peak) * 100;
      if (dd > mdd) mdd = dd;
    }
  }
  return pct2(mdd);
}

/**
 * 战绩卡指标五件套：胜率 / 盈亏比 / 最大回撤 / 交易频率 / 手续费占比
 * @param {object} o
 * @param {Array}  o.rounds pairTrades 产出的回合（含 open 状态）
 * @param {number} o.initialCapital 初始资金
 * @param {Array<number>} o.equitySeries 净值序列（用于最大回撤）
 * @param {number} o.activeDays 有交易的自然日数
 */
export function buildScorecard({ rounds = [], initialCapital = 0, equitySeries = [], activeDays = 0 } = {}) {
  const closed = rounds.filter((r) => r.status !== 'open');
  const wins = closed.filter((r) => r.realizedPnl > 0);
  const losses = closed.filter((r) => r.realizedPnl < 0);
  const grossProfit = wins.reduce((s, r) => s + r.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.realizedPnl, 0));
  const totalFee = rounds.reduce((s, r) => s + (Number(r.fee) || 0), 0);
  const totalRealized = closed.reduce((s, r) => s + r.realizedPnl, 0);
  const avgHoldDays =
    closed.length > 0 ? pct2(closed.reduce((s, r) => s + r.holdDays, 0) / closed.length) : 0;

  return {
    roundCount: closed.length,
    openCount: rounds.filter((r) => r.status === 'open').length,
    winRate: closed.length > 0 ? pct2((wins.length / closed.length) * 100) : 0,
    profitFactor: grossLoss > 0 ? pct2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    avgWin: wins.length > 0 ? round2(grossProfit / wins.length) : 0,
    avgLoss: losses.length > 0 ? round2(grossLoss / losses.length) : 0,
    maxDrawdown: maxDrawdownOf(equitySeries),
    tradeFrequency: activeDays > 0 ? pct2(rounds.length / activeDays) : 0,
    feeRatio: initialCapital > 0 ? pct2((totalFee / initialCapital) * 100) : 0,
    totalFee: round2(totalFee),
    totalRealized: round2(totalRealized),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    avgHoldDays,
  };
}

/* ------------------------------------------------------------------ *
 * RQ-10 行为复盘报告（规则诊断，非 LLM）                              *
 * ------------------------------------------------------------------ */

// 违禁模式：标的推荐 / 收益承诺 / 行情预测。
// 注意 \b\d{6}\b（六位股票代码）也在列 —— 复盘报告只谈行为，
// 一旦出现标的代码就意味着变相推荐，因此一律拦截。
const BANNED = [
  /必涨/,
  /稳赚/,
  /包赚/,
  /保证收益/,
  /翻倍/,
  /无风险/,
  /明天[\s\S]{0,12}涨/,
  /推荐[\s\S]{0,12}\d{6}/,
  /(买入|卖出|清仓|加仓)[\s\S]{0,6}\d{6}/,
  /\b\d{6}\b/,
];

/**
 * 合规闸门：报告不得出现标的推荐与收益承诺（RK-01）。
 * 只应传入自然语言文本（traits / suggestions），不要传整包 JSON ——
 * 数字字段（如手续费 123456.00）会误命中「六位代码」规则。
 */
export function complianceCheck(text) {
  const hits = BANNED.filter((re) => re.test(text)).map((re) => String(re));
  return { ok: hits.length === 0, hits };
}

/**
 * 生成行为诊断报告（纯函数）
 * @param {object} ctx { rounds, scorecard, initialCapital, currentAssets, benchmarkPct, returnPct }
 */
export function composeReport({ rounds = [], scorecard = {}, initialCapital = 0, currentAssets = 0, returnPct = 0, benchmarkPct = 0 } = {}) {
  const closed = rounds.filter((r) => r.status !== 'open');
  const traits = [];
  const suggestions = [];

  const sellRounds = closed;
  // 追涨倾向：买入当日该标的涨幅 >3% 的次数占比（用 buyPrice 与 sellPrice 无法判断，改用持仓周期代理）
  const shortHold = sellRounds.filter((r) => r.holdDays <= 1).length;
  const impatientRatio = sellRounds.length > 0 ? shortHold / sellRounds.length : 0;
  if (sellRounds.length >= 3 && impatientRatio >= 0.5) {
    traits.push({
      key: 'impatient',
      label: '持仓周期偏短',
      detail: `${sellRounds.length} 笔已平仓交易中有 ${shortHold} 笔在 1 天内了结，占比 ${pct2(impatientRatio * 100)}%。`,
    });
    suggestions.push('尝试给自己设一个最短持有期（例如 3 个交易日内不做反向操作），用纪律替代情绪决策。');
  }

  const winRounds = sellRounds.filter((r) => r.realizedPnl > 0);
  const lossRounds = sellRounds.filter((r) => r.realizedPnl < 0);
  if (winRounds.length > 0 && lossRounds.length > 0) {
    const avgWin = winRounds.reduce((s, r) => s + r.realizedPnl, 0) / winRounds.length;
    const avgLoss = Math.abs(lossRounds.reduce((s, r) => s + r.realizedPnl, 0) / lossRounds.length);
    const holdWin = winRounds.reduce((s, r) => s + r.holdDays, 0) / winRounds.length;
    const holdLoss = lossRounds.reduce((s, r) => s + r.holdDays, 0) / lossRounds.length;
    if (avgLoss > avgWin * 1.5) {
      traits.push({
        key: 'cut_loss',
        label: '亏损单的平均亏损大于盈利单的平均盈利',
        detail: `平均盈利 ¥${round2(avgWin)}，平均亏损 ¥${round2(avgLoss)}，盈亏比 ${scorecard.profitFactor ?? '-'}。`,
      });
      suggestions.push('亏损单平均持有更久、盈利单更早了结是典型的「截断利润、让亏损奔跑」，可先练习固定比例的止损纪律。');
    }
    if (holdLoss > holdWin * 1.5) {
      traits.push({
        key: 'hold_loss',
        label: '亏损持仓时间明显长于盈利持仓',
        detail: `盈利平均持有 ${pct2(holdWin)} 天，亏损平均持有 ${pct2(holdLoss)} 天。`,
      });
    }
  }

  if (Number(scorecard.feeRatio) > 1) {
    traits.push({
      key: 'overtrade',
      label: '交易频率偏高，费用侵蚀明显',
      detail: `手续费合计 ¥${scorecard.totalFee}，占初始资金 ${scorecard.feeRatio}%。`,
    });
    suggestions.push('把每笔交易的目标写下来再下单，减少「手痒型」交易，先观察手续费占比能否降到 1% 以内。');
  }

  if (Number(scorecard.maxDrawdown) >= 10) {
    traits.push({
      key: 'drawdown',
      label: '净值回撤偏大',
      detail: `区间最大回撤 ${scorecard.maxDrawdown}%。`,
    });
    suggestions.push('试着给单只标的设一个仓位上限（例如不超过总资产 30%），回撤会明显收敛。');
  }

  const openPositions = rounds.filter((r) => r.status === 'open');
  if (openPositions.length === 1) {
    const concentration = currentAssets > 0 ? (openPositions[0].costBasis / currentAssets) * 100 : 0;
    if (concentration >= 50) {
      traits.push({
        key: 'concentration',
        label: '持仓集中度偏高',
        detail: `单一标的占总资产约 ${pct2(concentration)}%。`,
      });
    }
  }

  const excess = pct2(Number(returnPct) - Number(benchmarkPct));
  if (sellRounds.length === 0) {
    suggestions.push('你还没有完整的「买入→卖出」回合，先完成第一笔卖出，复盘才有数据可用。');
  } else if (suggestions.length === 0) {
    suggestions.push(`当前 ${closed.length} 笔交易整体盈亏比 ${scorecard.profitFactor ?? '-'}，胜率 ${scorecard.winRate}%，保持现有节奏并持续记录即可。`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    headline: {
      returnPct: pct2(returnPct),
      benchmarkPct: pct2(benchmarkPct),
      excessPct: excess,
      outcome: excess > 0 ? '跑赢同期大盘' : excess < 0 ? '跑输同期大盘' : '与同期大盘持平',
    },
    scorecard,
    traits,
    suggestions: suggestions.slice(0, 3), // 硬性 1~3 条
    sampleSize: closed.length,
  };

  // 合规闸门：只对自然语言部分做扫描（数值字段不参与，避免误伤金额数字）
  const naturalText = [...traits.map((t) => `${t.label}${t.detail}`), ...suggestions].join(' ');
  const check = complianceCheck(naturalText);
  report.compliance = check.ok ? 'passed' : 'blocked';
  return check.ok ? report : { ...report, suggestions: [], traits: [], complianceNote: '内容未通过合规校验，已拦截' };
}

/* ------------------------------------------------------------------ *
 * DB 聚合                                                             *
 * ------------------------------------------------------------------ */

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, all: 0 };

/**
 * `/review/benchmark` 允许的最大回看天数（10 年）。
 * 产品侧最长只需覆盖 `all`（0 = 全区间），这里的上界纯粹是为了防止
 * 超大整数字面量进 `interval` 触发 22015；真实用户数据远小于此。
 */
const BENCHMARK_MAX_DAYS = 3650;

/**
 * 把 `/review/benchmark?days=` 的任意入参收敛成可直接拼进
 * `($n || ' days')::interval` 的安全值。
 *
 * 语义约定（与原实现保持一致，合法输入的结果不变）：
 *   - `0` 是「全区间」的哨兵值（不加时间过滤），原样保留；
 *   - 其余有限正数收敛到 [1, BENCHMARK_MAX_DAYS]；
 *   - NaN / Infinity / 负数 / 非法字符串一律回落缺省值。
 *
 * 为什么要单独抽出这个纯函数：`?days=Infinity`（含 1e309）会被拼成
 * `interval 'Infinity days'` 触发 **22007**，`?days=2147483648` 触发
 * **22015（interval field value out of range）**，两者都被兜成 500。
 * 内联在服务里就无法用单测锁住这条边界（本品
 * 的一致做法是把边界收敛到无 DB 依赖的纯函数再单测，见 utils/num.js）。
 */
export function normalizeBenchmarkDays(raw, fallback = 30) {
  const n = Number(raw);
  if (n === 0) return 0;
  return Number.isFinite(n) && n > 0 ? Math.min(BENCHMARK_MAX_DAYS, n) : fallback;
}

export function resolvePeriod(raw) {
  const p = String(raw || '30d');
  return Object.prototype.hasOwnProperty.call(PERIOD_DAYS, p) ? p : '30d';
}

async function recentIndexPct(days) {
  if (!days) {
    const { rows } = await pool.query(
      'SELECT index_value FROM index_snapshots ORDER BY created_at ASC LIMIT 1'
    );
    const end = await pool.query(
      'SELECT index_value FROM index_snapshots ORDER BY created_at DESC LIMIT 1'
    );
    if (rows.length === 0 || end.rows.length === 0) return 0;
    const a = Number(rows[0].index_value);
    const b = Number(end.rows[0].index_value);
    return a > 0 ? pct2(((b - a) / a) * 100) : 0;
  }
  const { rows } = await pool.query(
    `SELECT index_value FROM index_snapshots
      WHERE created_at >= now() - ($1 || ' days')::interval
      ORDER BY created_at ASC LIMIT 1`,
    [String(days)]
  );
  const end = await pool.query(
    'SELECT index_value FROM index_snapshots ORDER BY created_at DESC LIMIT 1'
  );
  if (rows.length === 0 || end.rows.length === 0) return 0;
  const a = Number(rows[0].index_value);
  const b = Number(end.rows[0].index_value);
  return a > 0 ? pct2(((b - a) / a) * 100) : 0;
}

/**
 * 用户在本周期内的决策记录（RQ-38），用于纪律执行率（RQ-76）。
 * blind_decisions 表由迁移 0016 创建；早期环境缺失时静默降级。
 */
async function loadUserDecisions(userId, days) {
  try {
    const args = [userId];
    let sql = `SELECT d.reason, d.stop_plan, d.skipped
                 FROM blind_decisions d
                 JOIN blind_sessions s ON s.id = d.session_id
                WHERE s.user_id = $1`;
    if (days > 0) {
      sql += ' AND d.created_at >= now() - ($2 || \' days\')::interval';
      args.push(String(days));
    }
    const { rows } = await pool.query(sql, args);
    return rows.map((r) => ({
      reason: r.reason,
      stopPlan: r.stop_plan === null ? null : Number(r.stop_plan),
      skipped: Boolean(r.skipped),
    }));
  } catch {
    return [];
  }
}

/** 复盘总览：配对交易 + 战绩卡 + AI 报告（带 fingerprint 缓存，保证 ≤10s 且内容稳定） */
export async function buildReview(userId, periodRaw, priceMap = {}) {
  const period = resolvePeriod(periodRaw);
  const days = PERIOD_DAYS[period];

  const txArgs = [userId];
  let txSql = 'SELECT * FROM transactions WHERE user_id=$1';
  if (days > 0) {
    txSql += ' AND created_at >= now() - ($2 || \' days\')::interval';
    txArgs.push(String(days));
  }
  txSql += ' ORDER BY created_at ASC';
  const tx = await pool.query(txSql, txArgs);

  const u = await pool.query('SELECT cash, initial_capital FROM users WHERE id=$1', [userId]);
  const initialCapital = u.rows[0] ? Number(u.rows[0].initial_capital) : 0;
  const cash = u.rows[0] ? Number(u.rows[0].cash) : 0;

  const list = tx.rows.map((r) => ({
    id: r.id,
    stockCode: r.stock_code,
    stockName: r.stock_name,
    type: r.type,
    quantity: r.quantity,
    price: Number(r.price),
    amount: Number(r.amount),
    fee: Number(r.fee),
    realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
    createdAt: r.created_at,
  }));

  const { rounds, realizedSum, feeSum } = pairTrades(list, priceMap);

  // 净值序列（取快照，无快照则退化为只有末点）
  const snapArgs = [userId];
  let snapSql = 'SELECT total_assets FROM asset_snapshots WHERE user_id=$1';
  if (days > 0) {
    snapSql += ' AND created_at >= now() - ($2 || \' days\')::interval';
    snapArgs.push(String(days));
  }
  snapSql += ' ORDER BY created_at ASC';
  const snap = await pool.query(snapSql, snapArgs);
  const equitySeries = snap.rows.map((r) => Number(r.total_assets));

  let mv = 0;
  for (const key of new Set(rounds.filter((r) => r.status === 'open').map((r) => r.code))) {
    if (priceMap[key] != null) mv += (rounds.find((r) => r.code === key && r.status === 'open')?.quantity || 0) * priceMap[key];
  }
  const currentAssets = round2(cash + mv);
  if (equitySeries.length === 0 && currentAssets > 0) equitySeries.push(currentAssets);

  const activeDaysSet = new Set(list.map((t) => new Date(t.createdAt).toISOString().slice(0, 10)));
  const scorecard = buildScorecard({
    rounds,
    initialCapital,
    equitySeries,
    activeDays: activeDaysSet.size,
  });

  const benchmarkPct = await recentIndexPct(days);
  const returnPct = initialCapital > 0 ? pct2(((currentAssets - initialCapital) / initialCapital) * 100) : 0;

  const report = composeReport({
    rounds,
    scorecard,
    initialCapital,
    currentAssets,
    returnPct,
    benchmarkPct,
  });

  // 校验：配对盈亏合计与账户已实现盈亏一致（≤0.01 元）
  const dbRealized = list.reduce((s, t) => s + (t.type === 'SELL' ? Number(t.realizedPnl || 0) : 0), 0);
  const consistent = Math.abs(dbRealized - realizedSum) <= 0.01;

  // RQ-76/77/78 交易体检单：与 scorecard 同源（同一份 rounds），保证两套指标可对账。
  // 决策记录来自双盲训练（RQ-38）；表缺失或查询失败时退化为「无决策记录」而非抛错，
  // 因为体检单的非决策项（期望值/R/持仓时间/最坏习惯）不依赖它。
  const decisions = await loadUserDecisions(userId, days);
  const checkup = buildCheckup({ rounds, decisions, initialCapital });

  const payload = {
    period,
    days,
    initialCapital,
    currentAssets,
    returnPct,
    benchmarkPct,
    excessPct: pct2(returnPct - benchmarkPct),
    realizedTotal: realizedSum,
    feeTotal: feeSum,
    consistency: { ok: consistent, diff: round2(Math.abs(dbRealized - realizedSum)) },
    rounds: rounds.slice(0, 200),
    scorecard,
    report,
    checkup,
  };

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ list: list.length, currentAssets, returnPct, benchmarkPct, scorecard, report }))
    .digest('hex')
    .slice(0, 64);

  // 内容未变则复用上次报告，保证重复查看瞬时返回且生成时间可追溯
  await pool.query(
    `INSERT INTO review_reports (user_id, period, payload, fingerprint)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, period) DO UPDATE
        SET payload = EXCLUDED.payload, fingerprint = EXCLUDED.fingerprint,
            generated_at = CASE WHEN review_reports.fingerprint = EXCLUDED.fingerprint
                                THEN review_reports.generated_at ELSE now() END`,
    [userId, period, JSON.stringify(payload), fingerprint]
  );

  return payload;
}

/** RQ-09 净值曲线叠加同期大盘 */
export async function equityVsBenchmark(userId, days = 30) {
  // days=0 是「全部区间」的哨兵值（不加时间过滤），必须原样保留；
  // 其余取值必须收敛上界：原写法只排除了 NaN/负数，`?days=Infinity`（含 1e309）
  // 与 `?days=2147483648` 会拼进 `($n || ' days')::interval`，分别触发
  // 22007（invalid input syntax for type interval）与
  // 22015（interval field value out of range），最终都被兜成 500。
  const d = normalizeBenchmarkDays(days);
  const snapArgs = [userId];
  let snapSql = `SELECT ((created_at AT TIME ZONE 'Asia/Shanghai')::date) AS d,
                        MAX(total_assets) AS total_assets
                   FROM asset_snapshots WHERE user_id=$1`;
  if (d > 0) {
    snapSql += ' AND created_at >= now() - ($2 || \' days\')::interval';
    snapArgs.push(String(d));
  }
  snapSql += ' GROUP BY 1 ORDER BY 1 ASC';
  const snap = await pool.query(snapSql, snapArgs);

  const idxArgs = [];
  let idxSql = `SELECT ((created_at AT TIME ZONE 'Asia/Shanghai')::date) AS d,
                       MAX(index_value) AS index_value
                  FROM index_snapshots`;
  if (d > 0) {
    idxSql += ' WHERE created_at >= now() - ($1 || \' days\')::interval';
    idxArgs.push(String(d));
  }
  idxSql += ' GROUP BY 1 ORDER BY 1 ASC';
  const idx = await pool.query(idxSql, idxArgs);

  const u = await pool.query('SELECT initial_capital, cash FROM users WHERE id=$1', [userId]);
  const initial = u.rows[0] ? Number(u.rows[0].initial_capital) : 0;

  const idxMap = new Map(idx.rows.map((r) => [String(r.d), Number(r.index_value)]));
  const baseIdx = idx.rows.length > 0 ? Number(idx.rows[0].index_value) : 0;

  const dates = snap.rows.map((r) => String(r.d));
  const equity = snap.rows.map((r) => ({
    date: String(r.d),
    totalAssets: Number(r.total_assets),
    returnPct: initial > 0 ? pct2(((Number(r.total_assets) - initial) / initial) * 100) : 0,
    benchmarkPct: idxMap.has(String(r.d)) && baseIdx > 0
      ? pct2(((idxMap.get(String(r.d)) - baseIdx) / baseIdx) * 100)
      : null,
  }));

  const excess =
    equity.length > 0 && equity[equity.length - 1].benchmarkPct != null
      ? pct2(equity[equity.length - 1].returnPct - equity[equity.length - 1].benchmarkPct)
      : null;

  return {
    days: d,
    dates,
    series: equity,
    hasBenchmark: idx.rows.length > 0,
    latestExcessPct: excess,
    note: '超额收益 = 用户收益率 − 同期大盘收益率，口径与排行榜一致',
  };
}

export async function latestReport(userId, periodRaw) {
  const period = resolvePeriod(periodRaw);
  const { rows } = await pool.query(
    'SELECT payload, generated_at FROM review_reports WHERE user_id=$1 AND period=$2',
    [userId, period]
  );
  return rows[0] ? { ...rows[0].payload, generatedAt: rows[0].generated_at } : null;
}
