-- 长尾与支撑能力：自选分组备注(RQ-28) / 密码找回(RQ-30) / 偏好(RQ-33) / 重置审计(RQ-34) / 埋点(RQ-35)

-- 自选股：分组 + 备注（关注理由）
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS group_name VARCHAR(30) NOT NULL DEFAULT '默认';
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS note       VARCHAR(500);
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 密码找回令牌：仅存哈希，令牌本身只通过邮件/开发模式返回
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ  NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pwd_reset_user ON password_reset_tokens(user_id, created_at DESC);

-- 账户重置审计：记录重置次数与重置前资产，排行榜据此标注起点变化（RQ-34）
CREATE TABLE IF NOT EXISTS account_resets (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assets_before  NUMERIC(18,2) NOT NULL,
  reset_count    INTEGER       NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_resets_user ON account_resets(user_id, created_at DESC);

-- 用户偏好：深色模式 / 信息密度（RQ-33）
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id  INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme    VARCHAR(10) NOT NULL DEFAULT 'light',   -- light | dark
  density  VARCHAR(10) NOT NULL DEFAULT 'normal',  -- compact | normal | loose
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 关键行为埋点（RQ-35）：回放训练 / 复盘查看 / 房间赛参与 / 引导完成
CREATE TABLE IF NOT EXISTS analytics_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,
  event      VARCHAR(40) NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_time ON analytics_events(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_user_time  ON analytics_events(user_id, created_at DESC);
