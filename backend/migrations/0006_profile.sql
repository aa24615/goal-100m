-- 个人资料扩展字段：昵称与头像（头像存储预设 key）
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar VARCHAR(20);
