/**
 * 逐笔结算可核对（RQ-134 / I-17 / F-62）
 *
 * v11 的判断很直接：这是**唯一 8 家竞品全部 ✗** 的维度。绕云/金K/叩富给的是聚合面板，
 * 大波浪刻意做服务端黑盒，FX Replay / TradingSim 没有逐笔规则明细——
 * 也就是说「我明明低买高卖，为什么收益对不上？」「为什么这单没成交？」
 * 这两个问题全行业没人回答。
 *
 * v10 已经写好了 `settlementService`（逐笔费用拆解 + 口径说明书），但它是**只读口径**，
 * 缺三样验收判据明确要求的东西：
 *   1. 撮合价**取自哪一根 K 线**（「为什么是这个价」——必须有可指认的根，不能只给数字）；
 *   2. 滑点**如实写出**（训练无滑点模型，写 0 才是可核对，写「有模型」是伪结论）；
 *   3. **被拒绝的委托**去哪了（拒绝原因 talking 到规则条款 + 下一步怎么做）。
 *
 * 因此本模块只做「审计层」，不重复 `settlementService` 的费用计算——
 * 费用一律走 `feeBreakdown`，避免第二口径（F-32 同类错误的复发路径）。
 *
 * 设计约束：
 *   - **纯函数**：不碰数据库。K 线由调用方以 `bars=[{seq,close}]` 注入，服务本身不发请求。
 *   - **双盲红线**：未揭示时对 `stock_code` / `stock_name` 一律返回 null，
 *     这与 `settlementService.buildOrderLine` 的既有口径一致（P5 回归不得破）。
 *   - **null 与 0 严格区分**：`Number(null) === 0` 会把「没记录到价格」显示成「以 0 元成交」，
 *     这是结算场景最严重的误导（v10 踩过）。
 */

import { buildOrderLine, feeBreakdown, SETTLEMENT_RULES } from './settlementService.js';

/** 训练撮合不引入滑点模型：这里是唯一事实来源，页面禁止另写一套 */
export const SLIPPAGE_RULE = {
  hasModel: false,
  value: 0,
  title: '滑点',
  body: '不引入滑点模型：成交价即收盘价，不额外加减点差。',
  verifiable: '逐笔明细的「成交价」应等于该根 K 线收盘价；出现偏离即为缺陷。',
};

/**
 * 拒绝原因 → 规则条款的映射表。
 *
 * 顺序敏感：越具体的规则排越前（` Seq ` 匹配要先于通用兜底）。
 * 每条都给出「怎么自己核对」+「下一步怎么做」——只丢一句「交易失败」对用户毫无帮助。
 */
export const REJECTION_RULES = [
  {
    key: 't1',
    title: 'T+1 当日不可卖',
    patterns: ['t+1', 't+0', '当日买入', '当日不可卖', '次交易日', '下一个交易日'],
    rule: '当日买入的仓位当日不可卖出，需等到下一个交易日。',
    howToVerify: '查看该笔买入的成交 seq，卖出 seq 必须大于它。',
    fix: '推进到下一根 K 线后再卖出；这是规则限制，不是撮合失败。',
  },
  {
    key: 'limit_up',
    title: '涨停无法买入',
    patterns: ['涨停', 'limit up', '已涨停'],
    rule: '委托价达到当日涨停价时，买单无法成交（无对手盘）。',
    howToVerify: '该根 K 线收盘价应等于当日涨停价。',
    fix: '涨停板追不进去属正常现象，可改为观察或换一局标的。',
  },
  {
    key: 'limit_down',
    title: '跌停无法卖出',
    patterns: ['跌停', 'limit down', '已跌停'],
    rule: '委托价达到当日跌停价时，卖单无法成交（无对手盘）。',
    howToVerify: '该根 K 线收盘价应等于当日跌停价。',
    fix: '跌停无法出货是真实风险；训练中的正确动作是提前设好止损计划。',
  },
  {
    key: 'limit_range',
    title: '超出涨跌停幅度',
    patterns: ['涨跌停', '价格超出', '超出当日', '幅度'],
    rule: '委托价超出当日涨跌停幅度时拒绝撮合。',
    howToVerify: '委托价与前一交易日收盘价之差应不超过板块限幅。',
    fix: '在当日价格区间内重新下单。',
  },
  {
    key: 'lot',
    title: '非整手',
    patterns: ['整手', '整百', '100 股', '100股', '整数倍'],
    rule: '委托数量必须是 100 股的整数倍。',
    howToVerify: '委托数量 ÷ 100 应为整数且大于 0。',
    fix: '把数量改成 100 的整数倍（如 100 / 300 / 500）。',
  },
  {
    key: 'suspended',
    title: '停牌无成交',
    patterns: ['停牌', '零成交', '无行情', '该交易日'],
    rule: '当日零成交（停牌）的标的不撮合。',
    howToVerify: '该根 K 线成交量为 0。',
    fix: '推进到下一根有成交的 K 线再操作。',
  },
  {
    key: 'position',
    title: '可卖数量不足',
    patterns: ['持仓不足', '可卖', '没有持仓', '可用股数'],
    rule: '卖出数量不得超过当前可卖持仓（含 T+1 冻结部分）。',
    howToVerify: '先看当前持仓与当日买入部分，再减出可卖数量。',
    fix: '降低卖出数量，或推进到 T+1 解禁之后再卖。',
  },
  {
    key: 'cash',
    title: '可用资金不足',
    patterns: ['资金不足', '可用资金', '余额不足', '买不起'],
    rule: '买入金额（含预估费用）不得超过可用资金。',
    howToVerify: '委托金额 + 预估费用应小于等于账户可用资金。',
    fix: '降低买入数量，或先卖出部分持仓释放资金。',
  },
  {
    key: 'market_closed',
    title: '非交易时段',
    patterns: ['非交易时段', '休市', '未开盘', '已收盘'],
    rule: '非交易日不接受撮合请求。',
    howToVerify: '对照交易日历确认该日为交易日。',
    fix: '下一个交易日再操作。',
  },
];

/** 未能归入任何已知规则的兜底：宁可说「未归类」，也不许假装认识了这句话 */
export const UNKNOWN_REJECTION = {
  key: 'unknown',
  title: '未归类原因',
  rule: '该拒绝原因未映射到已知规则条款。',
  howToVerify: '把页面显示的原始原因与撮合日志逐字比对。',
  fix: '这是我们的缺陷而不是你的操作问题——请反馈原始原因，我们补进规则表。',
};

function textOf(v) {
  return String(v ?? '').trim();
}

function lowerOf(v) {
  return textOf(v).toLowerCase();
}

/**
 * 把一句原始拒绝原因归类到规则条款（纯函数）。
 *
 * @param {unknown} reason 原始原因文案
 * @returns {{key:string,title:string,rule:string,howToVerify:string,fix:string,reason:string,known:boolean}}
 */
export function classifyRejection(reason) {
  const raw = lowerOf(reason);
  if (!raw) {
    return { ...UNKNOWN_REJECTION, reason: '', known: false };
  }
  for (const r of REJECTION_RULES) {
    if (r.patterns.some((p) => raw.includes(p.toLowerCase()))) {
      return { key: r.key, title: r.title, rule: r.rule, howToVerify: r.howToVerify, fix: r.fix, reason: textOf(reason), known: true };
    }
  }
  return { ...UNKNOWN_REJECTION, reason: textOf(reason), known: false };
}

/** 把 K 线数组规整成 seq → close 的映射，脏数据（null/NaN）直接丢弃而不是记成 0 */
function closeMapOf(bars) {
  const map = new Map();
  if (!Array.isArray(bars)) return map;
  for (const b of bars) {
    if (!b || typeof b !== 'object') continue;
    const seq = Number(b.seq);
    const close = Number(b.close);
    if (!Number.isFinite(seq)) continue;
    if (b.close === null || b.close === undefined || !Number.isFinite(close)) continue;
    map.set(seq, close);
  }
  return map;
}

/**
 * 撮合价溯源：回答「为什么是这个价」。
 *
 * 训练撮合按「当前推进到的那一根 K 线的收盘价」成交，因此成交价**必须**
 * 能在 K 线里指认出唯一的一根。指认不出来时如实说「无报价」，绝不猜。
 */
export function buildPriceOrigin({ seq, price, bars } = {}) {
  const map = closeMapOf(bars);
  const s = Number(seq);
  const hasSeq = Number.isFinite(s);
  const barClose = hasSeq && map.has(s) ? map.get(s) : null;

  const pRaw = price;
  const hasPrice = pRaw !== null && pRaw !== undefined && String(pRaw).trim() !== '';
  const p = hasPrice && Number.isFinite(Number(pRaw)) ? Number(pRaw) : null;

  // 容差 0.005 元：K 线收盘价入库为两位小数，撮合价同一口径，超过一分钱即为偏离
  const matched = barClose != null && p != null ? Math.abs(barClose - p) <= 0.005 : null;

  return {
    seq: hasSeq ? s : null,
    price: p,
    barClose,
    matched,
    basis: '撮合价 = 该根已揭示 K 线的收盘价，不引入点差与滑点',
    slippage: 0,
    hasQuote: barClose != null,
    note:
      barClose == null
        ? '未取到该根 K 线收盘价，无法溯源（多为行情缺失，非撮合错误）'
        : matched
          ? `第 ${hasSeq ? s : '—'} 根 K 线收盘价 ¥${barClose.toFixed(2)}，撮合价与之一致`
          : `撮合价 ¥${p == null ? '—' : p.toFixed(2)} 与第 ${hasSeq ? s : '—'} 根 K 线收盘价 ¥${barClose.toFixed(2)} 不一致，属撮合偏离`,
  };
}

/**
 * 单笔成交的完整审计行。
 *
 * 在 `settlementService.buildOrderLine` 之上补三件事（不重复计算费用）：
 *   priceOrigin 撮合价溯源 / slippage 滑点事实 / qa 三个必答问题
 */
export function buildOrderAudit(order, index = 0, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const base = buildOrderLine(order, index);
  const origin = buildPriceOrigin({ seq: base.seq ?? order?.seq, price: base.price, bars: o.bars });
  const fee = base.feeBreakdown || feeBreakdown(base.amount, base.side);

  const amountText = `¥${base.amount.toFixed(2)}`;
  const feeParts = [
    `佣金 ¥${fee.commission.toFixed(2)}${fee.minCommissionApplied ? `（不足 ¥5 按最低佣金计）` : ''}`,
    `过户费 ¥${fee.transfer.toFixed(2)}`,
    base.side === 'SELL' ? `印花税 ¥${fee.stamp.toFixed(2)}` : null,
  ].filter(Boolean);

  return {
    ...base,
    priceOrigin: origin,
    slippage: { applied: SLIPPAGE_RULE.hasModel, value: SLIPPAGE_RULE.value, rule: SLIPPAGE_RULE.body },
    /** 验收要求的三个必答问题：逐字对应 RQ-134 的「为什么是这个价 / 扣了多少费 / 为什么被拒」 */
    qa: {
      price: {
        question: '为什么是这个价？',
        answer: origin.note,
        verifiable: true,
        evidence: { seq: origin.seq, barClose: origin.barClose, matched: origin.matched },
      },
      fee: {
        question: '扣了多少费？',
        answer: `合计 ¥${fee.total.toFixed(2)}（${feeParts.join('、')}），成交额 ${amountText}。`,
        verifiable: true,
        evidence: { amount: base.amount, ...fee, recordedFee: base.recordedFee, feeMatched: base.feeMatched },
      },
      slippage: {
        question: '滑点多少？',
        answer: SLIPPAGE_RULE.body,
        verifiable: true,
        evidence: { hasModel: false, value: 0 },
      },
    },
  };
}

/**
 * 结算审计（纯函数）。
 *
 * @param {object} o
 * @param {Array}  [o.orders]     blind_orders 行
 * @param {Array}  [o.rejections] 被拒绝的委托：[{seq,side,quantity,reason}]
 * @param {Array}  [o.bars]       [{seq,close}]，用于撮合价溯源
 * @param {object} [o.session]    blind_sessions 行
 * @param {object} [o.score]      finishBlind 的 score
 * @param {boolean}[o.reveal]     是否已揭示标的（false 时隐去代码/名称）
 */
export function buildSettlementAudit(o) {
  const src = o && typeof o === 'object' ? o : {};
  const orders = Array.isArray(src.orders) ? src.orders : [];
  const rejections = Array.isArray(src.rejections) ? src.rejections : [];
  const session = src.session && typeof src.session === 'object' ? src.session : {};
  const score = src.score && typeof src.score === 'object' ? src.score : {};
  const finished = String(session.status || '').toUpperCase() === 'FINISHED';
  const reveal = src.reveal === undefined ? finished : Boolean(src.reveal);

  const lines = orders.map((od, i) => buildOrderAudit({ ...od, reveal }, i, { bars: src.bars }));
  const classified = rejections
    .map((r) => {
      const rc = r && typeof r === 'object' ? r : {};
      const c = classifyRejection(rc.reason);
      const seqNum = Number(rc.seq);
      return {
        seq: Number.isFinite(seqNum) ? seqNum : null,
        side: String(rc.side || '').toUpperCase() || 'UNKNOWN',
        sideLabel: String(rc.side || '').toUpperCase() === 'BUY' ? '买入' : String(rc.side || '').toUpperCase() === 'SELL' ? '卖出' : '未知',
        quantity: Math.max(0, Math.floor(Number(rc.quantity) || 0)),
        reason: c.reason,
        known: c.known,
        ruleKey: c.key,
        ruleTitle: c.title,
        rule: c.rule,
        howToVerify: c.howToVerify,
        fix: c.fix,
        code: reveal ? String(rc.stock_code ?? '') || null : null,
        text: `第 ${c.title}：${c.rule}（原始原因：${c.reason || '未给出'}）`,
      };
    })
    // 顺序：已知的排前，unknown 沉底，避免把「未归类」顶到第一行吓到用户
    .sort((a, b) => Number(b.known) - Number(a.known));

  const totalFee = lines.reduce((s, l) => s + l.fee, 0);
  const priceMismatch = lines.filter((l) => l.priceOrigin.matched === false).length;
  const feeMismatch = lines.filter((l) => l.feeMatched === false).length;
  const unknownRejections = classified.filter((r) => !r.known).length;

  return {
    applicable: finished,
    finished,
    reveal,
    rules: SETTLEMENT_RULES,
    slippageRule: SLIPPAGE_RULE,
    orders: lines,
    orderCount: lines.length,
    rejections: classified,
    rejectionCount: classified.length,
    totals: {
      amount: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
      fee: Math.round(totalFee * 100) / 100,
      realizedPnl: Math.round(lines.reduce((s, l) => s + (l.realizedPnl ?? 0), 0) * 100) / 100,
    },
    /**
     * 自检三项：任何一项不为 0 都说明「账面数字」与「公开口径」已经漂移，
     * 这种情况下谈可信度是没有意义的——必须在页面上说出来，而不是藏在日志里。
     */
    audit: {
      priceChecked: lines.filter((l) => l.priceOrigin.hasQuote).length,
      priceMismatch,
      feeChecked: lines.filter((l) => l.feeMatched !== null).length,
      feeMismatch,
      unknownRejections,
      ok: priceMismatch === 0 && feeMismatch === 0 && unknownRejections === 0,
      note: 'priceMismatch/feeMismatch/unknownRejections 三项全为 0 时，本局结算才可声称「逐笔可核对」。',
    },
    returnPct: Number.isFinite(Number(score.returnPct)) ? Number(score.returnPct) : null,
    buyHoldPct: Number.isFinite(Number(score.buyHoldPct)) ? Number(score.buyHoldPct) : null,
    disclaimer: '以上为模拟撮合，基于真实历史日线行情；不涉及任何真实证券业务，不构成投资建议。',
  };
}

/** 极简 CSV 转义：只处理 ", 与换行、前导符号，不引入依赖 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 结算明细 CSV：验收要求「导出 CSV 与页面显示逐笔一致」。
 * 因此表头与页面列一一对应，包括**成交与拒绝两类**（页面看得到拒绝，导出就不能少）。
 */
export function settlementAuditCsv(audit) {
  const a = audit && typeof audit === 'object' ? audit : {};
  const header = [
    '类型',
    '序号',
    'K线序号',
    '方向',
    '数量',
    '成交价',
    '成交额',
    '佣金',
    '印花税',
    '过户费',
    '费用合计',
    '已实现盈亏',
    '撮合价来源K线收盘价',
    '价格一致',
    '滑点',
    '拒绝原因归类',
    '对应规则',
    '怎么核对',
    '下一步',
  ];
  const rows = [];

  (Array.isArray(a.orders) ? a.orders : []).forEach((l) => {
    const f = l.feeBreakdown || {};
    rows.push([
      '成交',
      l.index,
      l.priceOrigin?.seq ?? '',
      l.sideLabel,
      l.quantity,
      l.price == null ? '' : l.price,
      l.amount,
      f.commission ?? '',
      f.stamp ?? '',
      f.transfer ?? '',
      l.fee,
      l.realizedPnl == null ? '' : l.realizedPnl,
      l.priceOrigin?.barClose ?? '',
      l.priceOrigin?.matched === true ? '是' : l.priceOrigin?.matched === false ? '否' : '未知',
      0,
      '',
      '',
      '',
      '',
    ]);
  });

  (Array.isArray(a.rejections) ? a.rejections : []).forEach((r, i) => {
    rows.push([
      '拒绝',
      i + 1,
      r.seq ?? '',
      r.sideLabel,
      r.quantity,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      r.reason || '',
      r.rule || '',
      r.howToVerify || '',
      r.fix || '',
    ]);
  });

  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return `\uFEFF${body}\r\n`;
}
