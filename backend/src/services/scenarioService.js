// 剧本训练场服务（RQ-16 ~ RQ-19）
//
// 设计要点
// - 行情由 **种子 + 纯函数** 生成：同一剧本每次进入的初始条件与行情序列完全一致（RQ-16 验收）
// - 交易撮合直接复用 replayService.simulateReplay，保证 T+1 / 涨跌停 / 费用与实时盘同源（RK-02）
// - 评分为确定性纯函数并保留评分明细，所有用户同规则、可复查（RQ-18）

import pool from '../db.js';
import { logger } from '../logger.js';
import { round2, pct2 } from '../utils/time.js';
import { simulateReplay } from './replayService.js';

/* ---------------- 确定性伪随机（mulberry32） ---------------- */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAILY_LIMIT = 0.1;

/* ---------------- RQ-16 剧本行情生成 ---------------- */

/**
 * 按剧本定义生成 bar 序列。同一个 seed 永远产出同一段行情。
 * @returns [{ seq, prices: { CODE: { open, high, low, close, prevClose } } }]
 */
export function generateScenarioBars({ type, seed, barCount = 40, startPrice = 20 }) {
  // 显式区分「未传（回落默认 40）」与「传了越界值（夹紧到 [2,400]）」：
  // 不能写成 Number(barCount) || 40 —— 那会把 0 当成未传而导致下界失效
  const raw = Number(barCount);
  const n = Number.isFinite(raw) ? Math.max(2, Math.min(400, Math.floor(raw))) : 40;
  const rnd = mulberry32(seed);
  const CODE = 'SCENARIO';
  let prevClose = Number(startPrice) || 20;
  const bars = [];

  for (let i = 0; i < n; i += 1) {
    const t = n > 1 ? i / (n - 1) : 0;
    let trend;
    switch (type) {
      case 'single_up':
        trend = 0.012 + 0.004 * (rnd() - 0.5);
        break;
      case 'sharp_drop':
        trend = t < 0.35 ? -0.035 - 0.01 * rnd() : 0.006 + 0.01 * (rnd() - 0.5);
        break;
      case 'volatile':
        trend = (rnd() - 0.5) * 0.06;
        break;
      case 'limit_up_trap':
        // 前段连续拉升至涨停附近诱多，后段回落
        trend = t < 0.3 ? 0.05 + 0.02 * rnd() : -0.028 - 0.015 * rnd();
        break;
      case 'illiquid':
        // 流动性枯竭：价格几乎不动、成交量极低
        trend = (rnd() - 0.5) * 0.004;
        break;
      case 'sideways':
        trend = (rnd() - 0.5) * 0.012;
        break;
      case 'v_reversal':
        trend = t < 0.45 ? -0.03 - 0.012 * rnd() : 0.032 + 0.012 * rnd();
        break;
      case 'grinding_down':
        trend = -0.008 - 0.006 * rnd();
        break;
      default:
        trend = (rnd() - 0.5) * 0.02;
    }

    const limitUp = prevClose * (1 + DAILY_LIMIT);
    const limitDown = prevClose * (1 - DAILY_LIMIT);
    const clamp = (v) => round2(Math.min(limitUp, Math.max(limitDown, v)));
    const open = clamp(prevClose * (1 + trend * 0.3));
    const close = clamp(prevClose * (1 + trend));
    const high = round2(Math.max(open, close) * (1 + Math.abs(trend) * 0.35 + rnd() * 0.004));
    const low = round2(Math.min(open, close) * (1 - Math.abs(trend) * 0.35 - rnd() * 0.004));
    const barPrev = prevClose;

    bars.push({
      seq: i + 1,
      prices: {
        [CODE]: {
          open: clamp(open),
          high: clamp(high),
          low: clamp(low),
          close: clamp(close),
          prevClose: barPrev,
        },
      },
    });
    prevClose = close;
  }
  return bars;
}

/* ---------------- RQ-18 多维度打分与评级 ---------------- */

/** 决策质量：买在当日低位、卖在当日高位为佳，取值 0~100 */
export function decisionQuality({ trades = [], bars = [] } = {}) {
  if (trades.length === 0) return 0;
  const bySeq = new Map(bars.map((b) => [b.seq, b]));
  let sum = 0;
  let cnt = 0;
  for (const t of trades) {
    const bar = bySeq.get(t.seq);
    const p = bar?.prices?.SCENARIO;
    if (!p) continue;
    const range = p.high - p.low;
    const pos = range > 0 ? (p.close - p.low) / range : 0.5; // 0=最低 1=最高
    const score = t.side === 'BUY' ? (1 - pos) * 100 : pos * 100;
    sum += Math.max(0, Math.min(100, score));
    cnt += 1;
  }
  return cnt > 0 ? pct2(sum / cnt) : 0;
}

export function gradeOf(total) {
  if (total >= 90) return 'S';
  if (total >= 80) return 'A';
  if (total >= 70) return 'B';
  if (total >= 60) return 'C';
  return 'D';
}

/**
 * 计算一次剧本尝试的评分（纯函数）
 * @param {object} o { def, trades }
 * @param {object} o.def { key, constraints: { initialCapital, maxTrades, maxDrawdownPct } }
 * @param {Array}  o.trades [{ seq, side, quantity }]
 */
/** 清洗客户端提交的操作流水：丢弃非法项，保证评分入参始终可控 */
export function sanitizeTrades(trades = []) {
  return (Array.isArray(trades) ? trades : [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({ seq: Number(t.seq), side: String(t.side || '').toUpperCase(), quantity: Number(t.quantity) }))
    .filter(
      (t) =>
        Number.isInteger(t.seq) &&
        t.seq >= 1 &&
        Number.isInteger(t.quantity) &&
        t.quantity > 0 &&
        ['BUY', 'SELL'].includes(t.side)
    );
}

export function scoreAttempt({ def, trades = [] }) {
  const c = def?.constraints || {};
  const initialCapital = Number(c.initialCapital) || 1000000;
  const maxTrades = Number(c.maxTrades) || 0;
  const maxDrawdownPct = Number(c.maxDrawdownPct) || 100;
  const bars = generateScenarioBars(def);
  const clean = sanitizeTrades(trades);

  const sim = simulateReplay({
    initialCapital,
    bars,
    orders: clean.map((t) => ({ seq: t.seq, code: 'SCENARIO', side: t.side, quantity: t.quantity })),
    uptoSeq: bars.length,
  });

  // 纪律：超限即扣分，逐项可复查
  const violations = [];
  if (maxTrades > 0 && sim.tradeCount > maxTrades) {
    violations.push({ key: 'maxTrades', detail: `超出交易次数上限 ${maxTrades} 次（实际 ${sim.tradeCount} 次）`, penalty: 40 });
  }
  if (sim.maxDrawdown > maxDrawdownPct) {
    violations.push({
      key: 'maxDrawdown',
      detail: `回撤 ${sim.maxDrawdown}% 超出上限 ${maxDrawdownPct}%`,
      penalty: 40,
    });
  }

  const returnScore = Math.max(0, Math.min(100, 50 + sim.returnPct * 10));
  const drawdownScore = Math.max(0, Math.min(100, 100 - sim.maxDrawdown * 4));
  const disciplineScore = Math.max(0, 100 - violations.reduce((s, v) => s + v.penalty, 0));
  const dqScore = decisionQuality({ trades: sim.trades, bars });

  const total = pct2(returnScore * 0.35 + drawdownScore * 0.25 + disciplineScore * 0.2 + dqScore * 0.2);
  // 必须有成交才算完成关卡：否则「什么都不做」也能拿到 60 分蒙混过关
  const passed = violations.length === 0 && sim.tradeCount > 0 && total >= 60;

  return {
    metrics: {
      returnPct: sim.returnPct,
      finalAssets: sim.totalAssets,
      maxDrawdown: sim.maxDrawdown,
      tradeCount: sim.tradeCount,
      rejected: sim.rejected,
    },
    score: {
      total,
      grade: gradeOf(total),
      passed,
      breakdown: {
        returnScore: pct2(returnScore),
        drawdownScore: pct2(drawdownScore),
        disciplineScore: pct2(disciplineScore),
        decisionScore: dqScore,
      },
      violations,
    },
    hints: buildHints({ def, sim, bars, passed }),
  };
}

/* ---------------- RQ-19 失败关卡关键节点提示 ---------------- */

export function buildHints({ def, sim, bars, passed }) {
  const hints = [];
  if (bars.length === 0) return hints;

  const closes = bars.map((b) => b.prices.SCENARIO.close);
  const bestIdx = closes.indexOf(Math.max(...closes));
  const worstIdx = closes.indexOf(Math.min(...closes));
  const highest = closes[bestIdx];
  const lowest = closes[worstIdx];

  if (!passed) {
    if (sim.tradeCount === 0) {
      hints.push({ node: '全程未成交', detail: '本关需要至少完成一次买入与卖出，先在低位区建立底仓。' });
    }
    for (const r of sim.rejected.slice(0, 3)) {
      hints.push({ node: `第 ${r.seq} 根 K 线`, detail: `${r.side === 'BUY' ? '买入' : '卖出'}未通过规则校验：${r.reason}` });
    }
  }

  if (sim.tradeCount > 0) {
    const buys = sim.trades.filter((t) => t.side === 'BUY');
    const sells = sim.trades.filter((t) => t.side === 'SELL');
    if (buys.length > 0) {
      const worstBuy = buys.reduce((a, b) => (b.price > a.price ? b : a), buys[0]);
      if (highest && worstBuy.price >= highest * 0.97) {
        hints.push({
          node: `第 ${worstBuy.seq} 根 K 线`,
          detail: `该点位接近全场最高价 ¥${round2(highest)}，属于追高买入，可尝试在回撤区建仓。`,
        });
      }
    }
    if (sells.length > 0) {
      const worstSell = sells.reduce((a, b) => (b.price < a.price ? b : a), sells[0]);
      if (lowest && worstSell.price <= lowest * 1.03) {
        hints.push({
          node: `第 ${worstSell.seq} 根 K 线`,
          detail: `该点位接近全场最低价 ¥${round2(lowest)}，属于恐慌卖出，可预先设定止损位并严格执行。`,
        });
      }
    }
    if (buys.length > 0 && sells.length === 0) {
      hints.push({ node: '持仓未了结', detail: '你建仓后没有卖出，本关无法结算完整交易，注意在目标位或时间窗结束前平仓。' });
    }
  }

  if (hints.length === 0) {
    hints.push({
      node: `第 ${bestIdx + 1} 根 K 线`,
      detail: `全场最高价 ¥${round2(highest)}，你已基本把握到主升段，可尝试进一步压缩回撤冲击 S 级。`,
    });
  }
  return hints.slice(0, 4);
}

/* ---------------- DB 层 ---------------- */

export const SCENARIO_DEFS = [
  { key: 'trend_riding', name: '拿住趋势：单边上涨', type: 'single_up', difficulty: 'easy', goal: '在单边上涨中持有到底，收益跑满整段涨幅', brief: '价格持续抬升，回撤很小，考验的是「拿不住盈利单」的老毛病。', bar_count: 40, seed: 20261001, constraints: { initialCapital: 500000, maxTrades: 4, maxDrawdownPct: 15 } },
  { key: 'stop_loss', name: '果断止损：急速下跌', type: 'sharp_drop', difficulty: 'medium', goal: '回撤控制在 8% 以内', brief: '开局急跌，随后弱势反弹，考验止损纪律是否到位。', bar_count: 40, seed: 20261002, constraints: { initialCapital: 500000, maxTrades: 6, maxDrawdownPct: 8 } },
  { key: 'chop_control', name: '别被洗出去：宽幅震荡', type: 'volatile', difficulty: 'hard', goal: '在剧烈震荡中把回撤控制在 12% 以内', brief: '价格大幅上下摆动，频繁交易会被反复打脸。', bar_count: 45, seed: 20261003, constraints: { initialCapital: 300000, maxTrades: 6, maxDrawdownPct: 12 } },
  { key: 'trap_avoid', name: '识别诱多：涨停陷阱', type: 'limit_up_trap', difficulty: 'hard', goal: '不在涨停附近追高，最终收益为正', brief: '前半段连续拉升制造强势假象，后半段快速回落。', bar_count: 42, seed: 20261004, constraints: { initialCapital: 500000, maxTrades: 4, maxDrawdownPct: 10 } },
  { key: 'patience', name: '学会等待：流动性枯竭', type: 'illiquid', difficulty: 'easy', goal: '交易次数不超过 2 次且不亏本金', brief: '几乎不动的死水行情，频繁操作只是在交手续费。', bar_count: 35, seed: 20261005, constraints: { initialCapital: 300000, maxTrades: 2, maxDrawdownPct: 5 } },
  { key: 'range_trade', name: '高抛低吸：区间震荡', type: 'sideways', difficulty: 'medium', goal: '在区间行情中取得正收益', brief: '价格在一个箱体内来回，适合练习网格思路。', bar_count: 45, seed: 20261006, constraints: { initialCapital: 500000, maxTrades: 8, maxDrawdownPct: 8 } },
  { key: 'reversal', name: '抄底与逃顶：V 型反转', type: 'v_reversal', difficulty: 'hard', goal: '在反转区完成一次完整买卖', brief: '先深跌后快速拉升，考验逆向思维与耐心。', bar_count: 42, seed: 20261007, constraints: { initialCapital: 500000, maxTrades: 4, maxDrawdownPct: 18 } },
  { key: 'slow_bleed', name: '拒绝温水：阴跌不止', type: 'grinding_down', difficulty: 'medium', goal: '亏损控制在 3% 以内', brief: '缓慢下行的温水行情，最容易让人麻木不止损。', bar_count: 40, seed: 20261008, constraints: { initialCapital: 500000, maxTrades: 4, maxDrawdownPct: 5 } },
];

export async function seedScenarios() {
  for (const d of SCENARIO_DEFS) {
    await pool.query(
      `INSERT INTO scenario_defs (key, name, type, difficulty, goal, brief, bar_count, seed, constraints)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, difficulty=EXCLUDED.difficulty,
         goal=EXCLUDED.goal, brief=EXCLUDED.brief, bar_count=EXCLUDED.bar_count,
         seed=EXCLUDED.seed, constraints=EXCLUDED.constraints`,
      [d.key, d.name, d.type, d.difficulty, d.goal, d.brief, d.bar_count, d.seed, JSON.stringify(d.constraints)]
    );
  }
  logger.info('剧本题库已就绪', { count: SCENARIO_DEFS.length });
}

export async function listScenarios(userId) {
  const { rows } = await pool.query('SELECT * FROM scenario_defs ORDER BY key');
  const best = await pool.query(
    `SELECT scenario_key, MAX((score->>'total')::numeric) AS best_score, COUNT(*)::int AS attempts
       FROM scenario_attempts WHERE user_id=$1 GROUP BY scenario_key`,
    [userId]
  );
  const bmap = new Map(best.rows.map((r) => [r.scenario_key, r]));
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    type: r.type,
    difficulty: r.difficulty,
    goal: r.goal,
    brief: r.brief,
    barCount: r.bar_count,
    constraints: r.constraints,
    bestScore: bmap.get(r.key)?.best_score == null ? null : Number(bmap.get(r.key).best_score),
    attempts: bmap.get(r.key)?.attempts || 0,
    disclaimer: '本场景为虚构行情，仅用于训练，不构成任何投资建议',
  }));
}

export async function getScenarioBars(key) {
  const { rows } = await pool.query('SELECT * FROM scenario_defs WHERE key=$1', [key]);
  if (!rows[0]) {
    const e = new Error('剧本不存在');
    e.status = 404;
    e.expose = true;
    // 「剧本不存在」是业务规则拒绝，不是报文非法：不打标记会污染 4xx 分类统计
    e.business = true;
    throw e;
  }
  const d = rows[0];
  const bars = generateScenarioBars(d);
  return {
    key: d.key,
    name: d.name,
    goal: d.goal,
    brief: d.brief,
    constraints: d.constraints,
    disclaimer: '本场景为虚构行情，仅用于训练，不构成任何投资建议',
    series: bars.map((b) => ({
      seq: b.seq,
      close: b.prices.SCENARIO.close,
      open: b.prices.SCENARIO.open,
      high: b.prices.SCENARIO.high,
      low: b.prices.SCENARIO.low,
    })),
  };
}

/** 提交一次尝试：服务端用同一引擎重算，客户端传来的只是操作流水 */
export async function submitAttempt({ userId, key, trades = [] }) {
  const { rows } = await pool.query('SELECT * FROM scenario_defs WHERE key=$1', [key]);
  if (!rows[0]) {
    const e = new Error('剧本不存在');
    e.status = 404;
    e.expose = true;
    // 同上：业务规则拒绝
    e.business = true;
    throw e;
  }
  const def = rows[0];
  const clean = trades
    .map((t) => ({ seq: Number(t.seq), side: String(t.side).toUpperCase(), quantity: Number(t.quantity) }))
    .filter((t) => Number.isInteger(t.seq) && Number.isInteger(t.quantity) && t.quantity > 0 && ['BUY', 'SELL'].includes(t.side));

  const result = scoreAttempt({ def, trades: clean });
  await pool.query(
    `INSERT INTO scenario_attempts (user_id, scenario_key, trades, metrics, score, passed)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, key, JSON.stringify(clean), JSON.stringify(result.metrics), JSON.stringify(result.score), result.score.passed]
  );
  logger.info('剧本尝试已提交', { userId, key, total: result.score.total, passed: result.score.passed });
  return result;
}

export async function listAttempts(userId, key, limit = 20) {
  const args = [userId];
  let sql = `SELECT scenario_key, metrics, score, passed, created_at FROM scenario_attempts WHERE user_id=$1`;
  if (key) {
    sql += ' AND scenario_key=$2';
    args.push(key);
  }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  const { rows } = await pool.query(sql, args);
  return rows.slice(0, Math.min(100, Math.max(1, Number(limit) || 20))).map((r) => ({
    scenarioKey: r.scenario_key,
    metrics: r.metrics,
    score: r.score,
    passed: r.passed,
    createdAt: r.created_at,
  }));
}
