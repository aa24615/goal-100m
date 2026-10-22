-- 新手引导与成长体系（RQ-12 ~ RQ-15）
-- guide_step：当前引导步序（0 未开始 / 1-4 四步 / 5 完成）
-- tasks：任务清单完成态（由真实行为推导后落库存档）
-- streak：连续练习（纯荣誉性质，无任何实物或现金奖励）
-- milestones：已达成的里程碑 key 列表

CREATE TABLE IF NOT EXISTS onboarding_state (
  user_id      INTEGER      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guide_step   INTEGER      NOT NULL DEFAULT 0,
  guide_done   BOOLEAN      NOT NULL DEFAULT FALSE,
  guide_skipped BOOLEAN     NOT NULL DEFAULT FALSE,
  tasks        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  streak       JSONB        NOT NULL DEFAULT '{"current":0,"best":0,"lastDate":null}'::jsonb,
  milestones   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 里程碑达成记录（可回看达成时间）
CREATE TABLE IF NOT EXISTS user_milestones (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        VARCHAR(40) NOT NULL,
  label      VARCHAR(80) NOT NULL,
  achieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
