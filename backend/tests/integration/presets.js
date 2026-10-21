// 集成测试前置（通过 `node --test --import ./tests/integration/presets.js` 加载）
// 必须在任何业务模块 import 之前执行，否则 db.js 会用错误的 DATABASE_URL 创建连接池，
// auth.js 的 JWT_SECRET 也会在模块顶层被解析。
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://papertrade:papertrade@localhost:5433/papertrade_test';
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'integration-test-secret-1234567890';
}
