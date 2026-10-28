-- 0019 v9 增长（RQ-107 短局 / RQ-108 免登录 / RQ-113 每日一题与净胜局 / RQ-114 归因）
--
-- 设计要点：
-- 1) blind_sessions.user_id 由 NOT NULL 放开为可空，并新增 guest_token：
--    RQ-108 要求「未登录也能走完一局并出成绩卡」。若给游客伪造一个 users 行，
--    注册用户数、首训完成率的分母会被污染（v9 的北极星全靠这个分母）。
--    因此游客会话用 guest_token 归属，user_id 留空，口径上永不混算。
-- 2) preset：RQ-107 短局化后，页面必须能回答「这一局是快局还是长局」，
--    否则「单局完成率」无法按局长解释。
-- 3) daily_challenge_entries 用 net_win（+1 / -1 / 0）而非收益率：
--    硬约束 6 —— 净胜局榜只展示「跑赢买入持有」的累计数，不展示绝对收益。
--    表结构中根本不存收益率字段，从物理上杜绝它出现在榜单里。

ALTER TABLE blind_sessions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE blind_sessions
  ADD COLUMN IF NOT EXISTS guest_token VARCHAR(64);

ALTER TABLE blind_sessions
  ADD COLUMN IF NOT EXISTS preset VARCHAR(16) NOT NULL DEFAULT 'standard';

CREATE INDEX IF NOT EXISTS idx_blind_sessions_guest
  ON blind_sessions (guest_token, created_at DESC)
  WHERE guest_token IS NOT NULL;

-- RQ-113 每日一题：全站同题。题目按日期唯一，抽题结果落库保证「同一天所有人同一道」。
CREATE TABLE IF NOT EXISTS daily_challenges (
  challenge_date DATE PRIMARY KEY,
  stock_code     VARCHAR(10) NOT NULL,
  stock_name     VARCHAR(40) NOT NULL,
  start_seq      INTEGER NOT NULL,
  end_seq        INTEGER NOT NULL,
  bars           INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 参赛记录：净胜局（+1 跑赢买入持有 / -1 跑输 / 0 打平）。
-- 刻意不设 return_pct 列 —— 不存就不可能展示，这是硬约束 6 的最低成本实现。
CREATE TABLE IF NOT EXISTS daily_challenge_entries (
  id             SERIAL PRIMARY KEY,
  challenge_date DATE NOT NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_token    VARCHAR(64),
  session_id     INTEGER REFERENCES blind_sessions(id) ON DELETE SET NULL,
  net_win        SMALLINT NOT NULL DEFAULT 0,
  finished_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一天同一人/同一游客只记一次重赛结果（重做取最新一次）
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_challenge_user
  ON daily_challenge_entries (challenge_date, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_challenge_guest
  ON daily_challenge_entries (challenge_date, guest_token)
  WHERE guest_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_daily_challenge_entries_date
  ON daily_challenge_entries (challenge_date);
