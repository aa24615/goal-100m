// 集成测试前置：把测试库清成干净状态。
//
// 背景：集成测试跑在共享的 papertrade_test 库上，而每个用例都会注册新账号。
// 不清理的话用户数会随执行次数线性增长（曾累积到 94 个），直接踩中两个坑：
//   1. 排行榜只返回前 TOP_N 名，榜外新用户被静默丢弃，断言随机失败；
//   2. 用例间相互依赖历史数据，换个执行顺序结果就不一样。
// 这里用 DROP SCHEMA + 重建的方式清理，比逐表 TRUNCATE 更彻底，
// 也不会因为新增迁移漏掉某张表；随后由 runMigrations 重新建表。

export async function resetDb(pool) {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO public').catch(() => {});
}
