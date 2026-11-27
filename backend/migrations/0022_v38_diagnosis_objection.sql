-- 0022 v38 拒绝归类留痕（RQ-226 / M48 / I-2）
--
-- 背景（v37 §4 I-2）：竞品都在给「正向画像」，没有一家允许用户说「我不同意这个诊断」。
-- 我方唯一站得住的差异化是「你可以自己重算、可以不同意」——
-- 但「可以不同意」若不落库，就只是一句口号，无法回答「用户到底质疑了哪些诊断」。
--
-- 本迁移只做一件事：diagnosis_objections —— 用户对诊断项标记「不同意」的结构化留痕。
--
-- 取舍说明：
--   1) 归属双轨（user_id / guest_token）：v10 踩过「游客 userId=null 被 Number 算成 0 撞外键」，
--      所以两列分开存，检查约束保证「有且仅有一种归属」；绝不把游客塞进 user_id=0。
--   2) 唯一索引覆盖 (user_id, guest_token, session_id, diagnosis_key)：
--      同一人同一会话同一诊断项只留一条，重复标记更新理由（与 diagnosisObjectionService.dedupe 对齐）。
--      NULLS NOT DISTINCT 保证游客（user_id 为 NULL）之间的去重也生效。
--   3) evidence_text / sample_size 快照当时诊断摘要：日后复核「当时给了什么结论」，
--      留痕不是只记一句「我不同意」，而是可对照的证据。
--   4) 不删原诊断：本表只叠加异议，任何诊断内容的删除都不在本迁移职责内。

CREATE TABLE IF NOT EXISTS diagnosis_objections (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_token   VARCHAR(64),
  session_id    INTEGER,
  diagnosis_key VARCHAR(40)  NOT NULL,
  reason        VARCHAR(300) NOT NULL,
  evidence_text VARCHAR(600),
  sample_size   INTEGER,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT diagnosis_objections_owner_check CHECK (
    (user_id IS NOT NULL AND guest_token IS NULL) OR
    (user_id IS NULL AND guest_token IS NOT NULL)
  )
);

-- 唯一去重：NULLS NOT DISTINCT（PG15+）让游客 user_id=NULL 也参与唯一约束。
-- 若目标库 < PG15，退回下方注释中的 COALESCE 表达式索引（二选一）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_diagnosis_objections_owner_session_key
  ON diagnosis_objections (user_id, guest_token, session_id, diagnosis_key) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_diagnosis_objections_key
  ON diagnosis_objections (diagnosis_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnosis_objections_session
  ON diagnosis_objections (session_id)
  WHERE session_id IS NOT NULL;

-- PG14 及以下替代方案（如迁移报错可手动启用）：
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_diagnosis_objections_owner_session_key
--   ON diagnosis_objections (COALESCE(user_id, -1), COALESCE(guest_token, ''), COALESCE(session_id, -1), diagnosis_key);
