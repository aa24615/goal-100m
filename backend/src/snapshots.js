import pool from './db.js';
import { getDetail } from './market.js';
import { logger } from './logger.js';

/**
 * 资产快照：定期记录每个用户的总资产，作为周/月/季/年榜的收益基准。
 * 没有历史净值就无法算周期收益，因此这是周期榜的数据地基。
 */

const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS || 60000); // 默认每分钟一次

export async function ensureSnapshotTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_snapshots (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total_assets  NUMERIC(18,2) NOT NULL,
      cash          NUMERIC(18,2) NOT NULL,
      market_value  NUMERIC(18,2) NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_snapshots_user_time ON asset_snapshots(user_id, created_at DESC)'
  );
  // 保留略长于一年，够年榜取基准，同时避免表无限增长
  await pool.query("DELETE FROM asset_snapshots WHERE created_at < now() - interval '400 days'");
}

async function totalAssetsOf(user) {
  const h = await pool.query('SELECT * FROM holdings WHERE user_id=$1', [user.id]);
  let mv = 0;
  for (const r of h.rows) {
    const d = getDetail(r.stock_code);
    const price = d ? d.price : Number(r.avg_cost);
    mv += r.quantity * price;
  }
  const cash = Number(user.cash);
  return { cash, mv, total: cash + mv };
}

export async function snapshotAll() {
  const u = await pool.query('SELECT id, cash FROM users ORDER BY id');
  if (u.rows.length === 0) return 0;

  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    for (const user of u.rows) {
      const { cash, mv, total } = await totalAssetsOf(user);
      await client.query(
        'INSERT INTO asset_snapshots (user_id, total_assets, cash, market_value) VALUES ($1,$2,$3,$4)',
        [
          user.id,
          Math.round(total * 100) / 100,
          Math.round(cash * 100) / 100,
          Math.round(mv * 100) / 100,
        ]
      );
      n += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return n;
}

export function startSnapshots() {
  const run = async () => {
    try {
      const n = await snapshotAll();
      if (n > 0) logger.debug('资产快照已记录', { users: n });
    } catch (e) {
      logger.error('资产快照写入失败', { err: e });
    }
  };
  run(); // 启动即记录一次，作为周期基准
  setInterval(run, SNAPSHOT_MS);
  logger.info('资产快照调度已启动', { intervalMs: SNAPSHOT_MS });
}
