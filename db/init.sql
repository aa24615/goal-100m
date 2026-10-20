-- 赚他一个小目标 - 模拟股票 - 数据库初始化
-- 该脚本在 postgres 数据卷首次初始化时自动执行

CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  username         VARCHAR(50)  NOT NULL UNIQUE,
  email            VARCHAR(120) NOT NULL UNIQUE,
  password_hash    VARCHAR(100) NOT NULL,
  cash             NUMERIC(18,2) NOT NULL DEFAULT 1000000,
  initial_capital  NUMERIC(18,2) NOT NULL DEFAULT 1000000,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stocks (
  code        VARCHAR(10) PRIMARY KEY,
  name        VARCHAR(40)  NOT NULL,
  sector      VARCHAR(30)  NOT NULL,
  prev_close  NUMERIC(12,2) NOT NULL,
  open_price  NUMERIC(12,2) NOT NULL,
  price       NUMERIC(12,2) NOT NULL,
  high        NUMERIC(12,2) NOT NULL,
  low         NUMERIC(12,2) NOT NULL,
  volume      BIGINT        NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS holdings (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code   VARCHAR(10) NOT NULL REFERENCES stocks(code) ON DELETE CASCADE,
  quantity     INTEGER NOT NULL,
  avg_cost     NUMERIC(12,2) NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, stock_code)
);

CREATE TABLE IF NOT EXISTS transactions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code   VARCHAR(10) NOT NULL,
  stock_name   VARCHAR(40) NOT NULL,
  type         VARCHAR(4)  NOT NULL,
  quantity     INTEGER NOT NULL,
  price        NUMERIC(12,2) NOT NULL,
  amount       NUMERIC(18,2) NOT NULL,
  fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资产快照：定期记录用户总资产，作为周/月/季/年榜的收益基准
CREATE TABLE IF NOT EXISTS asset_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_assets  NUMERIC(18,2) NOT NULL,
  cash          NUMERIC(18,2) NOT NULL,
  market_value  NUMERIC(18,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_user_time ON asset_snapshots(user_id, created_at DESC);
