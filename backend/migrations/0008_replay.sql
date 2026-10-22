-- 行情时间机器：回放训练（RQ-01 ~ RQ-06）
-- 设计要点：
--   1) 回放会话与真实账户完全隔离（独立的持仓 / 流水 / 净值表），不写 holdings / transactions / users
--   2) 所有推进都可由 (orders + cursor) 确定性重建，保证倒带后状态与历史完全一致（RQ-02）

CREATE TABLE IF NOT EXISTS replay_sessions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_seq       INTEGER        NOT NULL,
  end_seq         INTEGER        NOT NULL,
  cursor_seq      INTEGER        NOT NULL,
  initial_capital NUMERIC(18,2)  NOT NULL DEFAULT 1000000,
  status          VARCHAR(10)    NOT NULL DEFAULT 'RUNNING', -- RUNNING | FINISHED | ABORTED
  started_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_sec    INTEGER        NOT NULL DEFAULT 0,
  result          JSONB
);

CREATE INDEX IF NOT EXISTS idx_replay_sessions_user ON replay_sessions(user_id, started_at DESC);

-- 回放独立持仓（隔离 Sharding key = session_id）
CREATE TABLE IF NOT EXISTS replay_positions (
  session_id   BIGINT        NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  stock_code   VARCHAR(10)   NOT NULL,
  quantity     INTEGER       NOT NULL DEFAULT 0,
  avg_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, stock_code)
);

-- 回放 T+1 冻结量：与本笔买入所在的 bar 序号绑定（回放世界里「一个 bar = 一个交易日」）
-- last_buy_seq < cursor_seq 时该批股份可卖，等价于实时盘的 T+1
CREATE TABLE IF NOT EXISTS replay_lots (
  id          BIGSERIAL PRIMARY KEY,
  session_id  BIGINT        NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  stock_code  VARCHAR(10)   NOT NULL,
  seq         INTEGER       NOT NULL,   -- 买入发生在第几个 bar
  quantity    INTEGER       NOT NULL,
  remain      INTEGER       NOT NULL,
  avg_cost    NUMERIC(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_lots_session ON replay_lots(session_id, stock_code, seq);

-- 回放成交流水（不进 transactions，避免污染战绩与排行榜）
CREATE TABLE IF NOT EXISTS replay_orders (
  id           BIGSERIAL PRIMARY KEY,
  session_id   BIGINT        NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  stock_code   VARCHAR(10)   NOT NULL,
  stock_name   VARCHAR(40)   NOT NULL,
  side         VARCHAR(4)    NOT NULL,
  quantity     INTEGER       NOT NULL,
  price        NUMERIC(12,2) NOT NULL,
  amount       NUMERIC(18,2) NOT NULL,
  fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(18,2) NOT NULL DEFAULT 0,
  seq          INTEGER       NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replay_orders_session ON replay_orders(session_id, seq);

-- 每步净值：用于最大回撤与「同一行情多次训练对比」（RQ-04 / RQ-05）
CREATE TABLE IF NOT EXISTS replay_equity (
  session_id   BIGINT        NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  seq          INTEGER       NOT NULL,
  cash         NUMERIC(18,2) NOT NULL,
  market_value NUMERIC(18,2) NOT NULL,
  total_assets NUMERIC(18,2) NOT NULL,
  PRIMARY KEY (session_id, seq)
);
