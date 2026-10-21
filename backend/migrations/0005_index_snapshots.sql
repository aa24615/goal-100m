-- 大盘指数快照：与用户净值同口径，用于计算「超越大盘」的超额收益
CREATE TABLE IF NOT EXISTS index_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  index_value NUMERIC(18,4) NOT NULL,
  index_pct   NUMERIC(12,4) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
