import pool from './db.js';
import { getDetail, getSummary } from './market.js';
import { logger } from './logger.js';

/**
 * 资产快照：定期记录每个用户的总资产，作为周/月/季/年榜的收益基准。
 * 没有历史净值就无法算周期收益，因此这是周期榜的数据地基。
 */

const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS || 60000); // 默认每分钟一次

/** 记录一次大盘指数快照（与用户资产快照同频） */
export async function snapshotIndex() {
  const s = getSummary();
  await pool.query('INSERT INTO index_snapshots (index_value, index_pct) VALUES ($1, $2)', [
    s.indexValue,
    s.indexPct,
  ]);
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
      // 清理 400 天前的快照，避免表无限增长（保留略长于一年，够年榜取基准）
      await pool.query("DELETE FROM asset_snapshots WHERE created_at < now() - interval '400 days'");
      await pool.query("DELETE FROM index_snapshots WHERE created_at < now() - interval '400 days'");
      const n = await snapshotAll();
      await snapshotIndex();
      if (n > 0) logger.debug('资产快照已记录', { users: n });
    } catch (e) {
      logger.error('资产快照写入失败', { err: e });
    }
  };
  run(); // 启动即记录一次，作为周期基准
  setInterval(run, SNAPSHOT_MS);
  logger.info('资产快照调度已启动', { intervalMs: SNAPSHOT_MS });
}
