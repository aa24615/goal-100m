/**
 * 结算口径说明书（RQ-125 / I-13 / F-53）
 *
 * 要解决的是一句没说出口的怀疑：**「这个模拟成交价是不是假的？」**
 * 一旦用户起了这个疑心，整个训练的价值归零——他不会再相信任何一张成绩卡。
 * 这不是假想敌：海外头部 TradingSim（$33/月起）在公开评测里被反复批评
 * 「成交价高于报价、目标成交后止损未关」，说明「模拟撮合可核对」并不是行业默认项。
 *
 * 因此本模块做两件事：
 *   1. **逐笔可核对**：每一笔成交给出成交价取自哪一根 K 线的哪个价格、
 *      金额怎么算、费用怎么拆（佣金/印花税/过户费）、最低佣金是否触发；
 *   2. **口径可阅读**：把 T+1、涨跌停、整手、滑点写成一页人话说明，
 *      而不是让用户从代码里猜。
 *
 * 设计约束：
 *   - **纯函数**：不碰数据库、不发请求，入参残缺时降级为可读文案而不是抛错
 *     （v8 踩过：只读展示类函数对 null 入参抛 TypeError）。
 *   - **费率从 fees.js 取，不在此处硬编码**：后端费率是唯一事实来源，
 *     这里复制一份常量必然漂移。
 *   - **滑点如实写 0**：训练按当日收盘价撮合，没有滑点模型。
 *     把它写成「有滑点模型」是伪结论；写成「无滑点，成交价即收盘价」才是可核对的。
 */

import {
  COMMISSION_RATE,
  STAMP_RATE,
  TRANSFER_RATE,
  MIN_COMMISSION,
  T1_ENABLED,
  DAILY_LIMIT,
  feeConfig,
} from '../fees.js';

const SIDE_LABEL = { BUY: '买入', SELL: '卖出' };

/** 结算口径说明条目：顺序即页面展示顺序 */
export const SETTLEMENT_RULES = [
  {
    key: 'price',
    title: '成交价从哪来',
    body: '训练撮合按「当前推进到的那一根 K 线的收盘价」成交，即你按下买入/卖出时屏幕上最后一根已揭示 K 线的收盘价。',
    verifiable: '成绩卡逐笔明细里的成交价，应与该根 K 线收盘价完全一致。',
  },
  {
    key: 'slippage',
    title: '滑点',
    body: '不引入滑点模型。成交价即收盘价，不额外加减点差。',
    verifiable: '若你看到成交价等于收盘价，即为口径生效；任何偏离都属于缺陷。',
  },
  {
    key: 't1',
    title: 'T+1',
    body: T1_ENABLED ? '当日买入的仓位当日不可卖出，需等到下一个交易日。' : '当前部署已关闭 T+1 限制（T1_ENABLED=0）。',
    verifiable: '被 T+1 拦截的卖出会返回 400 并给出明确原因，不会静默成交。',
  },
  {
    key: 'limit',
    title: '涨跌停',
    body: `委托价超出当日涨跌停幅度（±${(DAILY_LIMIT * 100).toFixed(0)}%）时拒绝撮合。`,
    verifiable: '被拒绝的委托会返回 400 并说明原因，不产生成交记录。',
  },
  {
    key: 'lot',
    title: '整手',
    body: '委托数量必须是 100 股的整数倍，不足整手的委托直接拒绝。',
    verifiable: '非整百数量的下单请求返回 400，不会产生部分成交。',
  },
  {
    key: 'fee',
    title: '费用',
    body: `佣金 ${(COMMISSION_RATE * 10000).toFixed(0)}‱（单笔最低 ¥${MIN_COMMISSION}）、` +
      `卖出印花税 ${(STAMP_RATE * 10000).toFixed(0)}‱、过户费 ${(TRANSFER_RATE * 100000).toFixed(1)}‱。`,
    verifiable: '逐笔明细中「费用合计」应等于按上述费率重算的结果；最低佣金触发时该项为 ¥5。',
  },
];

/**
 * 数字格式化：**缺失必须显示为「—」而不是 0**。
 * `Number(null) === 0`，若沿用 Number 的默认转换，「没有成交价」会被显示成「成交价 ¥0.00」——
 * 那是把「没数据」伪装成「价格为零」，与 F-32 同类错误。
 */
function num(v, digits = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/**
 * 单笔费用拆解（纯函数，与 fees.calcFees 同一口径）。
 *
 * @param {number} amount 成交金额（元）
 * @param {'BUY'|'SELL'} side 方向
 */
export function feeBreakdown(amount, side) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) {
    return { commission: 0, stamp: 0, transfer: 0, total: 0, minCommissionApplied: false, amount: 0 };
  }
  const isSell = String(side || '').toUpperCase() === 'SELL';
  const rawCommission = a * COMMISSION_RATE;
  const minApplied = rawCommission < MIN_COMMISSION;
  const commission = Math.max(MIN_COMMISSION, rawCommission);
  const stamp = isSell ? a * STAMP_RATE : 0;
  const transfer = a * TRANSFER_RATE;
  const total = Math.round((commission + stamp + transfer) * 100) / 100;
  return {
    amount: Math.round(a * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    stamp: Math.round(stamp * 100) / 100,
    transfer: Math.round(transfer * 100) / 100,
    total,
    minCommissionApplied: minApplied,
  };
}

/** 缺失值判定：null / undefined / 空串一律视为「没数据」，与数值 0 严格区分 */
function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * 单笔成交的可核对明细。
 * 入参为 blind_orders 行（side/quantity/price/amount/fee/realized_pnl）。
 */
export function buildOrderLine(order, index = 0) {
  const o = order && typeof order === 'object' ? order : {};
  const side = String(o.side || '').toUpperCase();
  const qty = Math.max(0, Math.floor(Number(o.quantity) || 0));
  // 缺失与「价格为 0」必须区分：Number(null) === 0 会把「没记录到价格」显示成「以 0 元成交」，
  // 这在结算场景里是最严重的误导——用户会以为撮合把价格算丢了。
  const p = isBlank(o.price) ? null : Number.isFinite(Number(o.price)) ? Number(o.price) : null;
  const amount = isBlank(o.amount)
    ? p != null
      ? p * qty
      : 0
    : Number.isFinite(Number(o.amount))
      ? Number(o.amount)
      : 0;
  const fee = feeBreakdown(amount, side);
  const recordedFee = Number.isFinite(Number(o.fee)) ? Number(o.fee) : null;
  const realized = Number.isFinite(Number(o.realized_pnl)) ? Number(o.realized_pnl) : null;

  return {
    index: Math.max(0, Math.floor(Number(index) || 0)) + 1,
    seq: Number.isFinite(Number(o.seq)) ? Number(o.seq) : null,
    side: side || 'UNKNOWN',
    sideLabel: SIDE_LABEL[side] || '未知',
    quantity: qty,
    price: p,
    amount: fee.amount,
    fee: fee.total,
    feeBreakdown: fee,
    // 用户真正在意的核对点：**记账费用与按公开费率重算的费用是否一致**
    feeMatched: recordedFee == null ? null : Math.abs(recordedFee - fee.total) <= 0.02,
    recordedFee,
    realizedPnl: realized,
    // 训练中（未揭示）不得出现标的代码 —— 与双盲同一条红线
    code: o.reveal === false ? null : String(o.stock_code ?? '') || null,
    name: o.reveal === false ? null : String(o.stock_name ?? '') || null,
    text:
      `第 ${Math.max(0, Math.floor(Number(index) || 0)) + 1} 笔 · ${SIDE_LABEL[side] || '未知'} ` +
      `${qty} 股 @ ¥${num(p)}，成交额 ¥${num(fee.amount)}，` +
      `费用 ¥${num(fee.total)}（佣金 ${num(fee.commission)}${fee.minCommissionApplied ? '，已触发最低佣金 ¥5' : ''}` +
      `${side === 'SELL' ? `／印花税 ${num(fee.stamp)}` : ''}／过户费 ${num(fee.transfer)}）` +
      (realized == null ? '' : `，本笔已实现盈亏 ¥${num(realized)}`),
  };
}

/**
 * 结算说明书（纯函数）。
 *
 * @param {object} o
 * @param {Array}  [o.orders]  blind_orders 行数组
 * @param {object} [o.session] blind_sessions 行（含 status）
 * @param {object} [o.score]   finishBlind 的 score
 * @param {boolean} [o.reveal] 是否已揭示标的（未揭示时隐去代码与名称）
 */
export function buildSettlementSheet(o) {
  const src = o && typeof o === 'object' ? o : {};
  const orders = Array.isArray(src.orders) ? src.orders : [];
  const session = src.session && typeof src.session === 'object' ? src.session : {};
  const score = src.score && typeof src.score === 'object' ? src.score : {};
  const finished = String(session.status || '').toUpperCase() === 'FINISHED';
  const reveal = src.reveal === undefined ? finished : Boolean(src.reveal);

  const lines = orders.map((od, i) =>
    buildOrderLine({ ...od, reveal }, i)
  );

  const totalFee = lines.reduce((s, l) => s + l.fee, 0);
  const totalAmount = lines.reduce((s, l) => s + l.amount, 0);
  const buyAmount = lines.filter((l) => l.side === 'BUY').reduce((s, l) => s + l.amount, 0);
  const sellAmount = lines.filter((l) => l.side === 'SELL').reduce((s, l) => s + l.amount, 0);
  // 用户能自己复核的一条总账：卖出回款 − 买入支出 − 费用 = 已实现盈亏
  const realizedSum = lines.reduce((s, l) => s + (l.realizedPnl ?? 0), 0);
  const mismatch = lines.filter((l) => l.feeMatched === false).length;

  const summary =
    orders.length === 0
      ? '本局没有成交（全程观望），因此没有可核对的逐笔明细。'
      : `共 ${lines.length} 笔成交，买入 ¥${num(buyAmount)}、卖出 ¥${num(sellAmount)}，费用合计 ¥${num(totalFee)}。`;

  const reconciliation =
    orders.length === 0
      ? '无成交，无需对账。'
      : `对账式：卖出回款 ¥${num(sellAmount)} − 买入支出 ¥${num(buyAmount)} − 费用 ¥${num(totalFee)}，` +
        `与逐笔已实现盈亏之和 ¥${num(realizedSum)} 应同向；差额来自期末持仓的浮动盈亏（未平仓部分不计入已实现）。`;

  return {
    title: '本局结算口径',
    // RQ-109：完成 = 结算并出成绩卡；结算说明书只在完成后才有完整意义
    applicable: finished,
    finished,
    reveal,
    rules: SETTLEMENT_RULES,
    feeConfig: feeConfig(),
    orders: lines,
    orderCount: lines.length,
    totals: {
      amount: Math.round(totalAmount * 100) / 100,
      buyAmount: Math.round(buyAmount * 100) / 100,
      sellAmount: Math.round(sellAmount * 100) / 100,
      fee: Math.round(totalFee * 100) / 100,
      realizedPnl: Math.round(realizedSum * 100) / 100,
    },
    summary,
    reconciliation,
    // 自检：记账费用与按公开费率重算不一致的笔数，必须为 0
    feeAudit: {
      checked: lines.filter((l) => l.feeMatched !== null).length,
      mismatch,
      ok: mismatch === 0,
      note: 'feeMatched 为 true 表示「记账费用 = 按公开费率重算」；出现 false 即撮合与口径不一致。',
    },
    returnPct: Number.isFinite(Number(score.returnPct)) ? Number(score.returnPct) : null,
    buyHoldPct: Number.isFinite(Number(score.buyHoldPct)) ? Number(score.buyHoldPct) : null,
    text: [
      '【本局结算口径 · 赚一个小目标】',
      summary,
      ...lines.map((l) => l.text),
      reconciliation,
      ...SETTLEMENT_RULES.map((r) => `${r.title}：${r.body}`),
    ].join('\n'),
    disclaimer: '以上为模拟撮合，基于真实历史日线行情；不涉及任何真实证券业务，不构成投资建议。',
  };
}

export { SIDE_LABEL };
