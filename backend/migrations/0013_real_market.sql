-- 0013 真实 A 股数据支持
-- 目标：把标的池与日线历史从「模拟随机生成」切换为「真实 A 股数据」。
--
-- 关键约定：stock_daily.seq 仍是「稠密连续交易日序号」（1..N），不是日期编码。
-- 原因：回放训练（replay）用 cursor_seq ± 1 步进、并用 seq BETWEEN 取区间，
-- 一旦 seq 变成 YYYYMMDD，「+1」会落到非交易日导致回放失效。
-- 因此需要交易日历 trade_calendar 把 trade_date 映射为稠密 seq：
--   - 日历由 000001（1991 上市至今，覆盖几乎所有交易日）等长历史标的的 K 线日期构建
--   - 同步时按 date 查表得到 seq，保证与回放语义一致

ALTER TABLE stocks ADD COLUMN IF NOT EXISTS exchange    VARCHAR(2);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS listing_date DATE;
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS market_cap  NUMERIC(18,2);

-- 交易日历：trade_date -> 稠密序号 seq
CREATE TABLE IF NOT EXISTS trade_calendar (
  seq        INTEGER PRIMARY KEY,
  trade_date DATE NOT NULL UNIQUE
);

-- 日线：个股 K 线按 (code, seq)；全市场某日按 trade_date
CREATE INDEX IF NOT EXISTS idx_stock_daily_code_date ON stock_daily (code, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_daily_date      ON stock_daily (trade_date);

-- 行情中心按行业筛选
CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks (sector);

-- 同步断点/状态
CREATE TABLE IF NOT EXISTS sync_state (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
