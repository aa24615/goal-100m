-- 0014 交易状态（RQ-50 停牌 / 退市建模）
--
-- 背景：全市场对停牌、退市零建模（F-04），用户可以对停牌标的正常下单成功，
-- 事后才发现「这在真实市场根本不可能」。这里给出显式的交易状态列，
-- 由行情同步侧写入；未写入时 rules.js 仍会按「零成交 + 价格未变动」兜底判定停牌。

ALTER TABLE stocks ADD COLUMN IF NOT EXISTS trade_status VARCHAR(16) NOT NULL DEFAULT 'NORMAL';

-- 合法取值：NORMAL 正常 / HALTED 停牌 / DELISTED 退市
-- 用 CHECK 兜住脏值，避免 'halt' / '0' 之类写法绕过判定
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stocks_trade_status'
  ) THEN
    ALTER TABLE stocks
      ADD CONSTRAINT chk_stocks_trade_status
      CHECK (trade_status IN ('NORMAL', 'HALTED', 'DELISTED'));
  END IF;
END $$;

UPDATE stocks SET trade_status = 'NORMAL' WHERE trade_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_stocks_trade_status ON stocks (trade_status);
