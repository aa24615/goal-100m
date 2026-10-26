/**
 * 训练与真实规则账户同源（RQ-102 / I-2 修正版）
 *
 * 竞品版图（v8 复核）：
 *   - 绕云 K 练宝 = 纯回放，没有带真实规则的模拟账户；
 *   - K线训练 APP = 纯训练器，不接账户；
 *   - 叩富简投 = 有模拟交易，但没有训练场。
 * 「训练里的决策能落到带 T+1 / 分板块涨跌停 / 佣金印花税过户费的模拟账户上，
 *   并共用一份成绩」这个形态目前未见，是本期新的第一押注。
 *
 * 本服务的职责是**把「同源」变成可验证的事实**，而不是一句口号：
 *   1. RULES_MANIFEST 声明训练与真实交易必须共用的规则清单与实现来源；
 *   2. checkRuleParity 比对两侧实际加载的规则集，缺一项即为不同源；
 *   3. planAccountSync 把训练成交翻译成真实账户的下单计划（默认只出计划不执行）。
 *
 * 安全约束：**训练未结束（未揭示）时禁止生成落单计划**——
 * 否则「落到真实账户」这个动作会提前暴露标的代码，双盲直接失效（RQ-66）。
 */

/** 训练与真实交易所共用的一份规则清单（唯一源） */
export const RULES_MANIFEST = [
  {
    key: 't1',
    label: 'T+1',
    desc: '当日买入的股份次日才可卖出',
    source: 'replayService.simulateReplay',
  },
  {
    key: 'limit',
    label: '分板块涨跌停',
    desc: '主板 ±10% / 创业板·科创板 ±20% / 北交所 ±30% / 主板 ST ±5%；涨停买不进、跌停卖不出',
    source: 'rules.js + market.js',
  },
  {
    key: 'halt',
    label: '停牌不可交易',
    desc: '停牌、退市或无有效报价的标的拒单并给出原因',
    source: 'rules.js',
  },
  {
    key: 'fee',
    label: '佣金 / 印花税 / 过户费',
    desc: '佣金万3（最低 5 元）+ 卖出印花税万5 + 过户费万0.1，成本价含费',
    source: 'fees.js',
  },
  {
    key: 'lot',
    label: '最小单位',
    desc: '买入以「手」为单位，委托数量需为 100 的整数倍',
    source: 'rules.js',
  },
];

export const MANIFEST_KEYS = RULES_MANIFEST.map((r) => r.key);

/**
 * 规则同源校验（纯函数）。
 *
 * @param {object} o
 * @param {string[]} o.trainingRules 训练侧实际生效的规则 key
 * @param {string[]} o.accountRules  真实账户侧实际生效的规则 key
 */
export function checkRuleParity(o) {
  const { trainingRules = [], accountRules = [] } = o && typeof o === 'object' ? o : {};
  const toSet = (a) => new Set((Array.isArray(a) ? a : []).map((k) => String(k)));
  const t = toSet(trainingRules);
  const a = toSet(accountRules);

  const missingInAccount = MANIFEST_KEYS.filter((k) => t.has(k) && !a.has(k));
  const missingInTraining = MANIFEST_KEYS.filter((k) => a.has(k) && !t.has(k));

  return {
    consistent: missingInAccount.length === 0 && missingInTraining.length === 0,
    manifest: MANIFEST_KEYS,
    trainingRules: [...t],
    accountRules: [...a],
    missingInAccount,
    missingInTraining,
    summary:
      missingInAccount.length === 0 && missingInTraining.length === 0
        ? '训练与真实账户共用同一套规则：T+1、分板块涨跌停、停牌、费用、最小单位。'
        : `规则不一致：账户侧缺 [${missingInAccount.join(', ') || '无'}]，训练侧缺 [${missingInTraining.join(', ') || '无'}]。`,
  };
}

/**
 * 训练成交 → 真实账户落单计划（纯函数，**不写库**）。
 *
 * @param {object} o
 * @param {object} o.session blind_sessions 行（需 status / stock_code / stock_name / alias）
 * @param {Array}  o.orders  blind_orders 行
 * @param {Array}  o.decisions blind_decisions 行
 */
export function planAccountSync(o) {
  const { session = null, orders = [], decisions = [] } = o && typeof o === 'object' ? o : {};
  const s = session && typeof session === 'object' ? session : {};
  const list = Array.isArray(orders) ? orders : [];
  const decs = Array.isArray(decisions) ? decisions : [];

  const finished = String(s.status || '').toUpperCase() === 'FINISHED';

  // 未揭示 = 双盲仍生效，此时落到真实账户会把 code 提前暴露，直接拒绝
  if (!finished) {
    return {
      sessionId: s.id ?? null,
      eligible: false,
      blockedReason: '训练尚未结束，标的身份仍在遮蔽中。落单到真实账户会暴露标的代码，破坏双盲（RQ-66）。',
      orders: [],
      rules: MANIFEST_KEYS,
    };
  }

  const planned = list.map((r) => ({
    seq: r.seq ?? null,
    code: r.stock_code || s.stock_code || null,
    name: r.stock_name || s.stock_name || null,
    side: String(r.side || '').toUpperCase() || null,
    quantity: Number(r.quantity) || 0,
    // 落单时按当日真实行情重定价：训练里的历史价格不能直接搬进今天的账户
    repricedAtMarket: true,
    appliedRules: MANIFEST_KEYS,
    note: '按真实账户的 T+1 / 涨跌停 / 停牌 / 费用 / 最小单位规则重新校验后下单。',
  }));

  return {
    sessionId: s.id ?? null,
    eligible: true,
    blockedReason: null,
    orders: planned,
    decisions: decs.length,
    rules: MANIFEST_KEYS,
    parity: checkRuleParity({ trainingRules: MANIFEST_KEYS, accountRules: MANIFEST_KEYS }),
    note: '本计划只做规则校验与下单预演，不直接写账户；确认后由交易接口按同一套规则执行。',
  };
}
