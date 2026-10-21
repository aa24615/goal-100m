-- 限价委托表 + 撮合用索引
CREATE TABLE IF NOT EXISTS orders (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code   VARCHAR(10) NOT NULL,
  stock_name   VARCHAR(40) NOT NULL,
  side         VARCHAR(4) NOT NULL,
  limit_price  NUMERIC(12,2) NOT NULL,
  quantity     INTEGER NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  filled_price NUMERIC(12,2),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, stock_code);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
