-- 自选股持久化（替代此前仅存浏览器 localStorage 的方案，支持跨设备）
CREATE TABLE IF NOT EXISTS watchlist (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_code VARCHAR(10) NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stock_code)
);
