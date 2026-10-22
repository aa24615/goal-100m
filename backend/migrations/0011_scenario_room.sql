-- 剧本训练场（RQ-16 ~ RQ-19）与 房间赛（RQ-20 ~ RQ-22）

-- 剧本定义：固定题库（≥8 关），行情由种子确定性生成，不依赖运营持续出题
CREATE TABLE IF NOT EXISTS scenario_defs (
  key         VARCHAR(40) PRIMARY KEY,
  name        VARCHAR(60)  NOT NULL,
  type        VARCHAR(30)  NOT NULL,          -- single_up | sharp_drop | volatile | limit_up_trap | illiquid | sideways ...
  difficulty  VARCHAR(10)  NOT NULL DEFAULT 'easy', -- easy | medium | hard
  goal        TEXT         NOT NULL,          -- 训练目标
  brief       TEXT         NOT NULL,          -- 场景说明
  bar_count   INTEGER      NOT NULL DEFAULT 40,
  seed        INTEGER      NOT NULL,
  constraints JSONB        NOT NULL DEFAULT '{}'::jsonb, -- { initialCapital, maxTrades, maxDrawdownPct }
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenario_attempts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_key  VARCHAR(40)   NOT NULL REFERENCES scenario_defs(key) ON DELETE CASCADE,
  trades        JSONB         NOT NULL DEFAULT '[]'::jsonb,
  metrics       JSONB         NOT NULL DEFAULT '{}'::jsonb,
  score         JSONB         NOT NULL DEFAULT '{}'::jsonb, -- { total, grade, breakdown, hints }
  passed        BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenario_attempts_user ON scenario_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenario_attempts_key ON scenario_attempts(user_id, scenario_key, created_at DESC);

-- 房间赛
CREATE TABLE IF NOT EXISTS rooms (
  id               BIGSERIAL PRIMARY KEY,
  code             VARCHAR(8)   NOT NULL UNIQUE,       -- 邀请码
  name             VARCHAR(60)  NOT NULL,
  owner_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initial_capital  NUMERIC(18,2) NOT NULL DEFAULT 1000000,
  start_seq        INTEGER      NOT NULL,              -- 起始交易日序号（所有参与者一致）
  duration_sessions INTEGER     NOT NULL DEFAULT 1,    -- 1 / 3 / 5（1 日 / 3 日 / 1 周）
  status           VARCHAR(10)  NOT NULL DEFAULT 'RUNNING', -- RUNNING | CLOSED
  start_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  end_at           TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id     BIGINT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_assets NUMERIC(18,2) NOT NULL,                   -- 加入时锁定的统一初始资金
  joined_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  result      JSONB,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status, created_at DESC);
