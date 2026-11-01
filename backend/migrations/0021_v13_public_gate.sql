-- 0021 v13 挂门牌与责任闭环（RQ-158 一致性校验 / RQ-159 邀请归因 / RQ-160 发布验证留痕）
--
-- 背景（v13 §0 头号结论）：工程端连续两版稳定、代码层需求 100% 落地，
-- 但 **12 个用户里没有一个外部真人**，4521 条埋点 `is_test` 全为 f，
-- 而唯一能让真人进来的那扇门——公网入口——**连续第四版没有装**。
-- 连续四版「工具已给、没人执行」的根因不是技术，是**没有 owner、没有留痕、没有证据**。
--
-- 本迁移只做三件「让责任可断言」的事，不碰任何业务语义：
--   1) release_verifications —— 每次发布的验证结果落库。
--      RQ-160 的验收是「连续 2 次发布均有验证记录」；没有表，这句话只能靠口头声明，
--      而 v7 断在「提交未部署」、v10 断在「写完未提交」——两次都是发完没人验。
--   2) invite_codes —— 每个被邀请的人一条码。
--      RQ-159 要「≥5 名外部真实用户 + 5 份路径记录」；只有 `acquisition_channel`
--      这种粗粒度字段，5 个人进来后无法区分谁是谁，也拿不到「每份路径」。
--   3) users / analytics_events 的邀请归位列 —— 把「这个人是从哪条链接进来的」
--      从埋点顺序推断改成**注册时的事实落库**（v10 教训：埋点顺序不可靠）。
--
-- 取舍说明：三张表/列全部 `IF NOT EXISTS`，重复执行幂等；
-- `release_verifications.detail` 用 JSONB 而不是逐列建字段 —— 验证项会随版本增删，
-- 硬列会导致每次加检查项都要迁移，JSONB 让「检查项演进」不再牵动 schema。

-- ① 发布后验证记录（RQ-160）
CREATE TABLE IF NOT EXISTS release_verifications (
  id          SERIAL PRIMARY KEY,
  git_commit  VARCHAR(64),
  base_url    VARCHAR(300),
  ok          BOOLEAN NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  detail      JSONB    NOT NULL DEFAULT '[]'::jsonb,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_release_verifications_run_at
  ON release_verifications (run_at DESC);

-- ② 邀请码（RQ-159：外部用户归因的最小充分手段）
CREATE TABLE IF NOT EXISTS invite_codes (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL,
  channel      VARCHAR(40)  NOT NULL DEFAULT 'manual',
  label        VARCHAR(120),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  registered_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invite_codes_code
  ON invite_codes (code);

CREATE INDEX IF NOT EXISTS idx_invite_codes_channel
  ON invite_codes (channel, created_at DESC);

-- ③ 注册归位：邀请码与「这次注册是从哪条链接来的」落进用户行，
--    不依赖埋点顺序（v10 踩过：acquisition_channel 靠埋点顺序推断会错）。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_code VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_users_invite_code
  ON users (invite_code)
  WHERE invite_code IS NOT NULL;

-- ④ 埋点侧同样带上邀请码：RQ-159 的「流失点」要按人回溯，
--    只有 users 行有码时，注册之前的匿名事件无法归属（游客首训正是这种情况）。
CREATE INDEX IF NOT EXISTS idx_analytics_events_payload_invite
  ON analytics_events (((payload ->> 'inviteCode')))
  WHERE payload ? 'inviteCode';
