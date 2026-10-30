-- 0020 v12 度量可信度（RQ-143 埋点去重 / RQ-144 一致性校验 / RQ-147 有效完成 / RQ-149 自测标记）
--
-- 背景（v12 §0 头号发现）：北极星「首训完成率」被 0 笔成交、0.29 秒的空跑刷到 100%，
-- 与此同时 `blind_resume` 埋点 714 条 / 仅 2 个用户（单分钟 228 条 × 3 分钟）。
-- 也就是说：**埋点可以重复上报，业务表不会重复生成**，两者一除就得出荒谬结论。
-- 本迁移从物理层面堵住这两条路：
--   1) analytics_events 增加 dedupe_key + 唯一索引 —— 重复上报在数据库层直接被拒，
--      而不是靠「事后清洗」（事后清洗永远追不上新的污染）；
--   2) users / blind_sessions / analytics_events 增加 is_test —— 自测流量打标而非删除，
--      RQ-149 要求指标默认排除测试流量，但历史数据必须可追溯（RK-03）。
--
-- 取舍说明：dedupe_key 唯一索引做成**部分索引**（WHERE dedupe_key IS NOT NULL），
-- 这样历史存量行（dedupe_key 为 NULL）不会因为唯一约束而让迁移失败。

-- ① 埋点去重键：同一「主体 + 事件 + 去重维度」只保留第一条
ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(160);

-- ② 测试流量标记：打标而非删除（RK-03 要求保留可追溯性）
ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS test_reason VARCHAR(80);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS marked_test_at TIMESTAMPTZ;

-- ⑥ 注册来源留痕（RQ-148「非本机、非团队账号」的判定依据）：
--    没有 IP 与 UA，「5 名外部真实用户」这句话就无法被验证，只能靠口头声明。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_ip VARCHAR(64);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_ua VARCHAR(300);

ALTER TABLE blind_sessions
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- ③ 唯一约束：重复上报在库层被拒，返回 0 行受影响，调用方据此判定「已上报过」
CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_events_dedupe
  ON analytics_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_dedupe_scan
  ON analytics_events (event, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_is_test
  ON analytics_events (is_test, event)
  WHERE is_test = TRUE;

CREATE INDEX IF NOT EXISTS idx_users_is_test
  ON users (is_test)
  WHERE is_test = TRUE;

CREATE INDEX IF NOT EXISTS idx_blind_sessions_is_test
  ON blind_sessions (is_test)
  WHERE is_test = TRUE;

-- ④ 一致性校验辅助索引：RQ-144 每天要比对「埋点数 vs 业务表行数」，
--     blind_finish 的 payload 里带 sessionId，走 GIN 才能不扫全表
CREATE INDEX IF NOT EXISTS idx_analytics_events_payload_gin
  ON analytics_events USING GIN (payload jsonb_path_ops);

-- ⑤ 完成口径留痕：RQ-147 的「有效完成」是可推导的（score->>'tradeCount' + durationSec），
--     这里只加一列缓存判定结果，目的是让「历史空跑」可被一次性打标并永久可查，
--     而不是每次查询都重算一遍 JSON（历史 score 结构可能缺字段，重算会误判）。
ALTER TABLE blind_sessions
  ADD COLUMN IF NOT EXISTS effective_completed BOOLEAN;

ALTER TABLE blind_sessions
  ADD COLUMN IF NOT EXISTS effective_blockers JSONB;

CREATE INDEX IF NOT EXISTS idx_blind_sessions_effective
  ON blind_sessions (effective_completed, finished_at DESC)
  WHERE effective_completed IS NOT NULL;

-- ⑦ 被拒绝的委托（RQ-150「被拒绝的委托去哪了」）：
--    此前撮合被拒时只是 throw 一个 400，原因**没有任何地方留存**，
--    用户只看到一句「交易失败」，既不知道违反了哪条规则，也没法自己核对。
--    落库后结算口径说明书才能把拒绝归类到规则条款并给出「怎么核对 / 下一步」。
CREATE TABLE IF NOT EXISTS blind_rejections (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES blind_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  side       VARCHAR(8)  NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 0,
  price      NUMERIC(12,2),
  reason     TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blind_rejections_session
  ON blind_rejections (session_id, seq ASC);
