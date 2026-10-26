-- 0018 首训转化（RQ-91 会话持久化与断点续做 / RQ-96 漏斗 / RQ-105 获客归因）
--
-- 设计要点：
-- 1) last_active_at：断点续做要能回答「上次停在第几根、什么时候停的」。
--    created_at 只记录开始时刻，无法区分「刚开始」与「练到第 40 根才走」。
-- 2) 索引按 (user_id, last_active_at DESC) 建，与 findResumableSession 的
--    ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT 1 对齐，避免全表排序。
-- 3) acquisition_channel：获客实验（RQ-105）要求能说出「每个渠道的首训完成率」，
--    渠道必须落在用户行上，否则跨会话归因会随埋点顺序漂移。
--    只登记渠道名，不采集任何身份信息（硬约束 5）。

ALTER TABLE blind_sessions
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- 存量数据回填：迁移前已存在的会话按创建时间计，保证「上次停在第 N 根」可读
UPDATE blind_sessions SET last_active_at = created_at WHERE last_active_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_blind_sessions_resume
  ON blind_sessions (user_id, COALESCE(last_active_at, created_at) DESC);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS acquisition_channel VARCHAR(24);

CREATE INDEX IF NOT EXISTS idx_users_channel ON users (acquisition_channel);
