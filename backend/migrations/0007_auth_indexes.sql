-- 用户名 / 邮箱大小写归一化唯一索引（配合登录时 lower() 查询，避免大小写重复注册）
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (lower(email));
