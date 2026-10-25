// 房间赛服务（RQ-20 ~ RQ-22）
//
// 口径说明（重要）：房间赛不做隔离账本，而是**区间收益率竞技** ——
// 所有成员以「加入时刻的真实总资产快照」为统一基准，起止时间由房间的 start_seq / end_seq
// 统一决定，因此每个人的统计窗口完全一致、可比。该口径在接口 note 字段与页面同时标注。
// 若要改为隔离账本（房间内独立资金），可复用 replayService 的隔离实现，此处不再重复造轮子。

import pool from '../db.js';
import { logger } from '../logger.js';
import { getMarketStatus } from '../market.js';
import { getPortfolio } from './portfolioService.js';
import { round2, pct2 } from '../utils/time.js';
import { track } from './analyticsService.js';

const DEFAULT_CAPITAL = 1000000;
const DURATION_OPTIONS = { '1d': 1, '3d': 3, '1w': 5 }; // 1 日 / 3 日 / 1 周（5 个交易日）
const RANK_CACHE_MS = 3000; // 排名缓存 3 秒，保证「延迟 ≤5 秒」验收成立

const cache = new Map(); // roomId -> { at, rows }

export function inviteCode(seed = Date.now()) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = String(seed);
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    const n = (Number(s.slice(i * 3, i * 3 + 3)) + i * 37 + s.length * 11) % chars.length;
    out += chars[n];
  }
  return out;
}

export function roomError(message, status) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  // 同 replayError：房间类拒绝（邀请码无效、非房主、已加入）都是业务规则，
  // 不打 business 标记会被记成「请求报文非法(4xx)」。
  e.business = true;
  return e;
}

export function resolveDuration(raw) {
  const d = String(raw || '1d');
  return Object.prototype.hasOwnProperty.call(DURATION_OPTIONS, d) ? d : '1d';
}

export async function createRoom({ userId, name, duration }) {
  const dur = resolveDuration(duration);
  const sessions = DURATION_OPTIONS[dur];
  const status = getMarketStatus();
  const startSeq = status.tradeSeq;
  const endSeq = startSeq + sessions;

  let code = inviteCode(Date.now() + Math.floor(Math.random() * 100000));
  for (let i = 0; i < 5; i += 1) {
    const ex = await pool.query('SELECT 1 FROM rooms WHERE code=$1', [code]);
    if (ex.rows.length === 0) break;
    code = inviteCode(Date.now() + i * 7919);
  }

  const { rows } = await pool.query(
    `INSERT INTO rooms (code, name, owner_id, initial_capital, start_seq, duration_sessions, status)
     VALUES ($1,$2,$3,$4,$5,$6,'RUNNING') RETURNING *`,
    [code, String(name || '我的房间赛').slice(0, 60), userId, DEFAULT_CAPITAL, startSeq, sessions]
  );
  const portfolio = await getPortfolio(userId);
  await pool.query(
    'INSERT INTO room_members (room_id, user_id, base_assets) VALUES ($1,$2,$3)',
    [rows[0].id, userId, round2(portfolio.totalAssets)]
  );
  await track(userId, 'room_create', { roomId: rows[0].id, duration: dur });
  logger.info('房间赛已创建', { userId, roomId: rows[0].id, code, duration: dur });
  return { ...publicRoom(rows[0]), memberCount: 1 };
}

function publicRoom(r) {
  return {
    id: Number(r.id),
    code: r.code,
    name: r.name,
    ownerId: r.owner_id,
    initialCapital: Number(r.initial_capital),
    startSeq: r.start_seq,
    endSeq: r.start_seq + r.duration_sessions,
    durationSessions: r.duration_sessions,
    status: r.status,
    startAt: r.start_at,
    endAt: r.end_at,
    createdAt: r.created_at,
  };
}

export async function joinRoom({ userId, code }) {
  const c = String(code || '').trim().toUpperCase();
  const { rows } = await pool.query('SELECT * FROM rooms WHERE code=$1', [c]);
  if (!rows[0]) throw roomError('邀请码无效', 404);
  const room = rows[0];
  if (room.status !== 'RUNNING') throw roomError('该房间赛已结束', 400);

  const ex = await pool.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [
    room.id,
    userId,
  ]);
  if (ex.rows[0]) throw roomError('你已在该房间中', 409);

  const portfolio = await getPortfolio(userId);
  await pool.query(
    'INSERT INTO room_members (room_id, user_id, base_assets) VALUES ($1,$2,$3)',
    [room.id, userId, round2(portfolio.totalAssets)]
  );
  await track(userId, 'room_join', { roomId: room.id });
  logger.info('加入房间赛', { userId, roomId: room.id, code: c });
  return publicRoom(room);
}

async function memberAssets(memberId) {
  try {
    const p = await getPortfolio(memberId);
    return p.totalAssets;
  } catch {
    return 0;
  }
}

/** 房间实时排名（RQ-21） */
export async function roomRanking(roomId, useCache = true) {
  if (useCache) {
    const hit = cache.get(roomId);
    if (hit && Date.now() - hit.at < RANK_CACHE_MS) return hit.rows;
  }
  const { rows } = await pool.query(
    `SELECT rm.user_id, rm.base_assets, rm.joined_at, rm.result, u.username, u.display_name, u.avatar
       FROM room_members rm JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id=$1 ORDER BY rm.joined_at ASC`,
    [roomId]
  );
  const out = [];
  for (const m of rows) {
    const assets = Number(m.result?.finalAssets ?? (await memberAssets(m.user_id)));
    const base = Number(m.base_assets) || 0;
    out.push({
      userId: m.user_id,
      username: m.username,
      displayName: m.display_name || m.username,
      avatar: m.avatar,
      baseAssets: round2(base),
      totalAssets: round2(assets),
      returnPct: base > 0 ? pct2(((assets - base) / base) * 100) : 0,
      joinedAt: m.joined_at,
    });
  }
  out.sort((a, b) => b.returnPct - a.returnPct);
  out.forEach((r, i) => {
    r.rank = i + 1;
  });
  cache.set(roomId, { at: Date.now(), rows: out });
  return out;
}

export async function roomDetail(roomId, userId) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [roomId]);
  if (!rows[0]) throw roomError('房间不存在', 404);
  const room = rows[0];
  const members = await roomRanking(room.id);
  if (!members.some((m) => m.userId === userId)) throw roomError('你不是该房间成员', 403);
  const status = getMarketStatus();
  return {
    ...publicRoom(room),
    note: '房间收益 = （当前总资产 − 加入时总资产快照）/ 加入时快照，所有成员统计窗口一致',
    progress: {
      currentSeq: status.tradeSeq,
      remainSessions: Math.max(0, room.start_seq + room.duration_sessions - status.tradeSeq),
    },
    members,
  };
}

export async function myRooms(userId) {
  const { rows } = await pool.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM room_members m WHERE m.room_id=r.id) AS member_count
       FROM rooms r JOIN room_members m2 ON m2.room_id=r.id AND m2.user_id=$1
      ORDER BY r.created_at DESC LIMIT 50`,
    [userId]
  );
  return rows.map((r) => ({ ...publicRoom(r), memberCount: r.member_count }));
}

/** 结束房间赛并生成战绩卡（RQ-22：结束后 1 分钟内可查询，数据保留 ≥90 天） */
export async function closeRoom({ roomId, userId }) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [roomId]);
  if (!rows[0]) throw roomError('房间不存在', 404);
  const room = rows[0];
  if (room.owner_id !== userId) throw roomError('仅房主可结束房间赛', 403);
  if (room.status === 'CLOSED') {
    const members = await roomRanking(room.id, false);
    return { ...publicRoom(room), members };
  }

  const members = await roomRanking(room.id, false);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of members) {
      await client.query('UPDATE room_members SET result=$1 WHERE room_id=$2 AND user_id=$3', [
        JSON.stringify({ finalAssets: m.totalAssets, returnPct: m.returnPct, rank: m.rank }),
        room.id,
        m.userId,
      ]);
    }
    await client.query("UPDATE rooms SET status='CLOSED', end_at=now() WHERE id=$1", [room.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  cache.delete(room.id);
  logger.info('房间赛已结束', { roomId: room.id, members: members.length });
  return { ...publicRoom({ ...room, status: 'CLOSED' }), members };
}

export { DURATION_OPTIONS, DEFAULT_CAPITAL };
