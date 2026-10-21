-- 交易表/持仓表的扩展字段（T+1 冻结量、已实现盈亏、成交后现金与持仓余量）
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS t1_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS last_buy_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(18,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_after NUMERIC(18,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS holding_qty_after INTEGER;
