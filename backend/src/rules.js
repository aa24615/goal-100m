/**
 * A 股真实交易规则引擎（RQ-49 分板块涨跌幅 / RQ-50 停牌不可交易）
 *
 * 设计原则：
 * 1. **纯函数、零 DB 依赖** —— 规则本身必须可单测，撮合/下单链路只消费结果。
 * 2. **规则表化 + 默认值兜底** —— 未识别的代码不会抛错，落到主板口径并标注 `fallback`，
 *    避免「识别不全 → 整笔下单失败」把不可用放大成不可用线（RK-04）。
 * 3. **拒绝必须带原因** —— 停牌/退市/无报价一律返回机器可读 code + 中文原因，
 *    解决 F-04「用户下单成功事后才发现这在真实市场不可能」。
 *
 * 板块口径（2026 年 A 股现行规则）：
 *   主板（60/00 开头）                        ±10%
 *   创业板（300/301）                          ±20%
 *   科创板（688/689）                          ±20%
 *   北交所（43/83/87/88/920 开头）             ±30%
 *   风险警示（名称含 ST）仅主板降为            ±5%
 *      —— 创业板 ST 仍为 ±20%、北交所风险警示仍为 ±30%，因此 ST 只在主板生效。
 *   新股上市前 5 个交易日（主板）              无涨跌幅限制
 */

/** 板块规则表：唯一来源，修改这里等于修改全市场口径 */
export const BOARD_RULES = {
  MAIN: { board: 'MAIN', label: '主板', limit: 0.1 },
  GEM: { board: 'GEM', label: '创业板', limit: 0.2 },
  STAR: { board: 'STAR', label: '科创板', limit: 0.2 },
  BSE: { board: 'BSE', label: '北交所', limit: 0.3 },
};

/** 风险警示（ST/*ST）在主板单独收窄到 ±5%；其它板块沿用板块幅度 */
export const ST_LIMIT = 0.05;
/** 新股上市首日无涨跌幅限制的天数 */
export const NEW_LISTING_EXEMPT_DAYS = 5;
/** 识别不出板块时的兜底幅度（不得因规则缺失而拒单） */
export const FALLBACK_LIMIT = 0.1;

const BSE_PREFIXES = ['43', '83', '87', '88', '920'];
const GEM_PREFIXES = ['300', '301'];
const STAR_PREFIXES = ['688', '689'];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

/**
 * 识别板块。按「代码前缀」判定，名称只用于识别风险警示。
 * @returns {{board:string, boardLabel:string, riskWarning:boolean, fallback:boolean}}
 */
export function classifyBoard(code, name) {
  const c = normCode(code);
  const n = String(name || '');
  const riskWarning = /ST/i.test(n);
  let board = null;
  if (STAR_PREFIXES.some((p) => c.startsWith(p))) board = 'STAR';
  else if (GEM_PREFIXES.some((p) => c.startsWith(p))) board = 'GEM';
  else if (BSE_PREFIXES.some((p) => c.startsWith(p))) board = 'BSE';
  // 沪市 60 / 深市 00 / 其余已知前缀未覆盖的一律按主板兜底
  const fallback = board === null;
  if (fallback) board = 'MAIN';
  const rule = BOARD_RULES[board];
  return { board, boardLabel: rule.label, riskWarning, fallback };
}

/**
 * 计算某只标的的涨跌幅约束。
 * @param {string} code 股票代码
 * @param {string} name 股票名称（用于识别 ST）
 * @param {number} prevClose 昨收
 * @param {string} [listingDate] 上市日期 YYYY-MM-DD，用于新股免涨跌幅判定
 * @param {Date|number} [now] 基准时间
 * @returns {{board, boardLabel, riskWarning, limit:number|null, limitUp:number|null,
 *            limitDown:number|null, exempt:boolean, exemptReason:string|null, prevClose:number}}
 */
export function priceLimitOf(code, name, prevClose, listingDate, now = new Date()) {
  const cls = classifyBoard(code, name);
  const prev = Number(prevClose);
  // 昨收非法（停牌/无数据）时不能做乘除：既不放大也不拒绝，返回 null 由调用方降级为「免涨跌停校验」
  const validPrev = Number.isFinite(prev) && prev > 0;

  let limit = BOARD_RULES[cls.board].limit;
  let exempt = false;
  let exemptReason = null;

  if (cls.riskWarning && cls.board === 'MAIN') limit = ST_LIMIT;

  // 新股上市前 N 日无涨跌幅限制（仅界面已知的上市日期才敢放开，缺失则按常规幅度，宁可保守）
  const days = daysSinceListing(listingDate, now);
  if (days !== null && days >= 0 && days < NEW_LISTING_EXEMPT_DAYS) {
    exempt = true;
    exemptReason = `新股上市第 ${days + 1} 个交易日，无涨跌幅限制`;
  }

  const effective = exempt || !validPrev ? null : limit;
  return {
    ...cls,
    limit: effective,
    limitUp: effective === null ? null : round2(prev * (1 + effective)),
    limitDown: effective === null ? null : round2(prev * (1 - effective)),
    exempt,
    exemptReason,
    prevClose: validPrev ? prev : 0,
  };
}

/** 距上市日的自然日天数；上市日期缺失或非法返回 null（不代表第 0 天） */
export function daysSinceListing(listingDate, now = new Date()) {
  if (!listingDate) return null;
  const d = new Date(String(listingDate).slice(0, 10));
  if (Number.isNaN(d.getTime())) return null;
  const base = now instanceof Date ? now.getTime() : Number(now);
  return Math.floor((base - d.getTime()) / 86400000);
}

/**
 * 停牌 / 退市 / 无报价判定。
 * 返回 null 表示可正常交易；否则返回机器可读原因对象。
 *
 * 判定顺序（由强到弱）：显式状态码 > 退市 > 无报价 > 零成交疑似停牌
 *
 * @param {object} stock { code, name, price, prevClose, volume, amount, tradeStatus, quoteAgeMs }
 */
export function haltReason(stock = {}) {
  // null / 非对象输入也要安全：调用方可能直接透传 `getDetail()` 的空结果。
  // 这里统一降级为「无有效报价」，而不是抛 TypeError 把下单接口打成 500。
  const s = stock && typeof stock === 'object' ? stock : {};
  const status = String(s.tradeStatus || '').toUpperCase();
  if (status === 'DELISTED') {
    return { code: 'DELISTED', boardHalt: true, message: '该标的已退市，不可交易' };
  }
  if (status === 'HALTED') {
    return { code: 'HALTED', boardHalt: true, message: '该标的当前停牌，不可交易' };
  }

  const price = Number(s.price);
  const prevClose = Number(s.prevClose);

  // 价格缺失或非正：连「现在多少钱」都不知道，任何成交价都是凭空编的
  if (!Number.isFinite(price) || price <= 0) {
    return { code: 'NO_QUOTE', boardHalt: true, message: '该标的暂无有效报价，不可交易' };
  }
  // 零成交 + 价格未变动 → 停牌。前提是**调用方明确给了成交量**：
  // 拿不到 volumn 时不能凭猜测定停牌，否则会把正常标的全部拒掉（RK-04 误拒单率 <1%）。
  const v = s.volume;
  if (v !== undefined && v !== null && Number.isFinite(Number(v)) && Number(v) === 0) {
    if (Number.isFinite(prevClose) && prevClose > 0 && price === prevClose) {
      const stale = Number(s.quoteAgeMs);
      const staleHint = Number.isFinite(stale) && stale > 0 ? `，行情已 ${Math.round(stale / 1000)} 秒未更新` : '';
      return {
        code: 'SUSPENDED',
        boardHalt: true,
        message: `该标的当日零成交且价格未变动${staleHint}，判定为停牌，不可交易`,
      };
    }
  }
  return null;
}

/**
 * 下单前的统一规则闸门（市价单 / 限价单 / 回放共用同一口径）。
 *
 * @param {object} p
 * @param {string} p.code
 * @param {string} p.name
 * @param {number} p.price      拟成交价（市价单为最新价，限价单为委托价）
 * @param {number} p.prevClose
 * @param {string} [p.tradeStatus]
 * @param {string} [p.listingDate]
 * @param {number} [p.volume]
 * @param {number} [p.quantity]
 * @param {'BUY'|'SELL'} [p.type]
 * @param {Date} [p.now]
 * @returns {{ok:true, limits:object} | {ok:false, status:number, code:string, message:string, limits:object}}
 */
export function guardTrade(p = {}) {
  const limits = priceLimitOf(p.code, p.name, p.prevClose, p.listingDate, p.now);

  const halted = haltReason(p);
  if (halted) {
    return { ok: false, status: 400, code: halted.code, message: halted.message, limits };
  }

  // 数量为 0 / 负数 / 非整手一律拒绝。此前只判「> 0 且非整手」，
  // 0 与负数会静默通过规则闸门，把校验责任推给下游各条链路（三条链路口径不一致）。
  const qty = Number(p.quantity);
  const qtyGiven = p.quantity !== undefined && p.quantity !== null && String(p.quantity) !== '';
  if (qtyGiven && (!Number.isFinite(qty) || qty <= 0 || qty % 100 !== 0)) {
    return {
      ok: false,
      status: 400,
      code: 'LOT_SIZE',
      message: qty <= 0 ? '委托数量需为正整数' : '委托数量需为 100 的整数倍',
      limits,
    };
  }

  const price = Number(p.price);
  const type = String(p.type || '').toUpperCase();
  if (limits.limitUp != null && Number.isFinite(price)) {
    if (type === 'BUY' && price >= limits.limitUp * 0.999) {
      return {
        ok: false,
        status: 400,
        code: 'LIMIT_UP',
        message: `已到涨停价 ¥${limits.limitUp}（${limits.boardLabel}${limits.riskWarning ? '·ST' : ''}），买单无法成交`,
        limits,
      };
    }
    if (type === 'SELL' && price <= limits.limitDown * 1.001) {
      return {
        ok: false,
        status: 400,
        code: 'LIMIT_DOWN',
        message: `已到跌停价 ¥${limits.limitDown}（${limits.boardLabel}${limits.riskWarning ? '·ST' : ''}），卖单无法成交`,
        limits,
      };
    }
  }

  return { ok: true, limits };
}

/** 对外暴露给 GET /api/config/fees，让前端同时拿到板块规则表（避免前端再硬编码一套） */
export function boardRuleTable() {
  const out = {};
  for (const [k, v] of Object.entries(BOARD_RULES)) {
    out[k] = { label: v.label, limit: v.limit };
  }
  return { boards: out, stLimit: ST_LIMIT, newListingExemptDays: NEW_LISTING_EXEMPT_DAYS };
}
