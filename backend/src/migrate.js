import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

/**
 * 轻量数据库迁移器（零依赖，离线友好）
 * - schema_migrations 记录已应用的版本，保证幂等、可重复执行
 * - 每个迁移文件为编号 SQL（如 0001_core.sql），内容须可重复执行
 *   （优先使用 CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）
 * - 未来任何"数据库改动"都应新增一个带更大编号的迁移文件，而非修改已有文件或 init.sql
 */
export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  let files = [];
  try {
    files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    logger.warn('迁移目录不存在，跳过数据库迁移', { dir: MIGRATIONS_DIR });
    return;
  }

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      await pool.query('COMMIT');
      logger.info('数据库迁移已应用', { version });
    } catch (e) {
      await pool.query('ROLLBACK').catch(() => {});
      logger.error('数据库迁移失败', { version, err: e });
      throw e;
    }
  }
  logger.info('数据库迁移检查完成', { total: files.length, alreadyApplied: applied.size });
}
