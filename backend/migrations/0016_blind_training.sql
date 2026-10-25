-- 0016 双盲训练（RQ-66 双盲 / RQ-67 随机来一段 / RQ-38 强制决策记录 / RQ-41 成绩含纪律执行率）
--
-- 设计要点：
-- 1) 与真实账户完全隔离：训练成交只写 blind_* 表，绝不触碰 users/holdings/transactions（RQ-42）。
-- 2) 片段可溯源：start_seq/end_seq 指向 stock_daily 的稠密序号，揭示后能定位到具体标的与日期区间。
-- 3) 决策点强制留痕：blind_decisions 记录「买/卖/观望 + 理由 + 计划止损」，
--    skipped=true 即「未记录」，用于计算纪律执行率（RQ-41 / RQ-76）。

CREATE TABLE IF NOT EXISTS blind_sessions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code       VARCHAR(10) NOT NULL,
  stock_name       VARCHAR(40) NOT NULL,
  -- 遮蔽期间的对外代号，界面只显示它（如「标的 #7F3A」）
  alias            VARCHAR(40) NOT NULL,
  start_seq        INTEGER NOT NULL,
  end_seq          INTEGER NOT NULL,
  cursor_seq       INTEGER NOT NULL,
  initial_capital  NUMERIC(18,2) NOT NULL DEFAULT 1000000,
  status           VARCHAR(12) NOT NULL DEFAULT 'RUNNING', -- RUNNING | FINISHED
  score            JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_blind_sessions_user ON blind_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blind_orders (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES blind_sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  stock_code   VARCHAR(10) NOT NULL,
  stock_name   VARCHAR(40) NOT NULL,
  side         VARCHAR(4)  NOT NULL,
  quantity     INTEGER NOT NULL,
  price        NUMERIC(12,2) NOT NULL,
  amount       NUMERIC(18,2) NOT NULL,
  fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(18,2) DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blind_orders_session ON blind_orders (session_id, seq ASC);

CREATE TABLE IF NOT EXISTS blind_decisions (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES blind_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  action     VARCHAR(8) NOT NULL, -- BUY | SELL | HOLD
  reason     TEXT,
  stop_plan  NUMERIC(12,2),
  skipped    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blind_decisions_session ON blind_decisions (session_id, seq ASC);
