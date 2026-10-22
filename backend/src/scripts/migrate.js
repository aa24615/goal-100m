/**
 * 数据库迁移 CLI（可在宿主机直接执行）
 *   DATABASE_URL=postgresql://papertrade:papertrade@localhost:5433/papertrade npm run migrate
 */
import { runMigrations } from '../migrate.js';
import pool from '../db.js';

runMigrations(pool)
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('[迁移失败]', e);
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  });
