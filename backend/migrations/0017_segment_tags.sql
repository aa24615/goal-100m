-- 0017 片段特征标签 / 训练处方 / 多周期粒度（RQ-81 / RQ-82 / RQ-83）
--
-- 全部为纯增量语句（ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS），
-- 可安全重复执行；迁移器不提供 down，回滚需手工 DROP。

-- RQ-82 片段特征标签：trend 趋势 / range 震荡 / pullback 回撤 / volatile 高波动
-- 写在会话上而不是每次实时算：标签一旦确定就必须与训练者看到的走势一致，
-- 若每次重算，行情补数后标签漂移会让「按标签筛选」的结果不可复现。
ALTER TABLE blind_sessions ADD COLUMN IF NOT EXISTS segment_tag VARCHAR(12);
ALTER TABLE blind_sessions ADD COLUMN IF NOT EXISTS tag_metrics JSONB;

-- RQ-83 训练处方：记录本次训练是依据哪一条最坏习惯生成的，
-- 使「体检 → 训练」的闭环可回溯（验收要求：处方强制记录项与纪律执行率口径一致）。
ALTER TABLE blind_sessions ADD COLUMN IF NOT EXISTS prescription_key VARCHAR(32);

-- RQ-81 多周期：当前只有日线。列先建好，数据不可得时页面明示粒度而非假装支持。
-- 取值：day | m60 | m30 | m15 | m5，目前仅 day 有数据。
ALTER TABLE blind_sessions ADD COLUMN IF NOT EXISTS granularity VARCHAR(8) NOT NULL DEFAULT 'day';

CREATE INDEX IF NOT EXISTS idx_blind_sessions_tag ON blind_sessions (segment_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blind_sessions_granularity ON blind_sessions (granularity);
