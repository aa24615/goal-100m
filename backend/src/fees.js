/**
 * 交易费用与交易规则的唯一来源（后端权威）
 * 前端不再硬编码费率，改为启动时拉取 GET /api/config/fees
 */

export const COMMISSION_RATE = 0.0003; // 佣金 万3
export const STAMP_RATE = 0.0005; // 印花税 万5（仅卖出）
export const TRANSFER_RATE = 0.00001; // 过户费 万0.1
export const MIN_COMMISSION = 5; // 单笔最低佣金（元）

// T+1：当日买入不可卖（T1_ENABLED=0 关闭）
export const T1_ENABLED = process.env.T1_ENABLED !== '0';
// 报价保护：客户端展示价与成交价偏离超过该比例则拒绝
export const PRICE_TOLERANCE = Number(process.env.PRICE_TOLERANCE || 0.005);
// 涨跌停幅度
export const DAILY_LIMIT = 0.10;

export function calcFees(amount, type) {
  const commission = Math.max(MIN_COMMISSION, amount * COMMISSION_RATE);
  const stamp = type === 'SELL' ? amount * STAMP_RATE : 0;
  const transfer = amount * TRANSFER_RATE;
  return Math.round((commission + stamp + transfer) * 100) / 100;
}

export function feeConfig() {
  return {
    commissionRate: COMMISSION_RATE,
    stampRate: STAMP_RATE,
    transferRate: TRANSFER_RATE,
    minCommission: MIN_COMMISSION,
    t1Enabled: T1_ENABLED,
    dailyLimit: DAILY_LIMIT,
    priceTolerance: PRICE_TOLERANCE,
  };
}
