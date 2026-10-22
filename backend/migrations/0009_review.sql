-- 复盘与战绩中心（RQ-07 ~ RQ-11）
-- 说明：买卖配对、战绩指标、最大回撤均可由 transactions 纯计算得到，本身不落库；
--       只有「AI 复盘报告」需要持久化，用于 10 秒内秒回、导出与历史回看。

CREATE TABLE IF NOT EXISTS review_reports (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period       VARCHAR(10)   NOT NULL DEFAULT '30d',  -- 7d | 30d | 90d | all
  payload      JSONB         NOT NULL,                -- 报告正文（含免责声明）
  fingerprint  VARCHAR(64)   NOT NULL,                -- 数据指纹：内容未变则复用缓存
  generated_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (user_id, period)
);

CREATE INDEX IF NOT EXISTS idx_review_reports_user ON review_reports(user_id, generated_at DESC);
