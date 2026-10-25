-- 0015 可观测底座（RQ-75 前端运行时错误上报）
--
-- 背景：浏览器侧崩溃/未捕获异常在服务端日志里**完全不可见**（F-00 元级缺陷），
-- 缺陷只能靠用户撞出来、再从生产日志里回溯。这里建表承接前端上报，
-- 并强制「不采集任何未脱敏个人身份信息」——只存结构化错误指纹，不存 token / 请求体 / 手机号。

CREATE TABLE IF NOT EXISTS frontend_errors (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 错误指纹：name + message + 首帧，用于聚合「同一个 bug 影响了多少人」
  fingerprint  VARCHAR(64) NOT NULL,
  kind         VARCHAR(24) NOT NULL DEFAULT 'error', -- error | unhandledrejection | manual
  name         VARCHAR(120),
  message      TEXT,
  stack        TEXT,
  url          VARCHAR(512),
  user_agent   VARCHAR(512),
  app_version  VARCHAR(40),
  -- 业务上下文（路由、组件等），由上报侧脱敏后写入
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frontend_errors_time ON frontend_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frontend_errors_fp   ON frontend_errors (fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frontend_errors_user ON frontend_errors (user_id, created_at DESC);

-- RQ-74 埋点新增双盲训练事件：analytics_events 表已存在，这里只补索引与说明口径
-- blind_start / blind_finish / blind_decision 由 analyticsService.EVENTS 统一管理
CREATE INDEX IF NOT EXISTS idx_analytics_events_time ON analytics_events (event, created_at DESC);
