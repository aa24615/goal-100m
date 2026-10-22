import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBoard } from '../../src/services/leaderboardService.js';

// 排行榜展示层取数（RQ-23 / RQ-34）
// 背景：榜单只下发前 TOP_N 名，榜外用户看不到自己 —— 包括 RQ-34 标注的重置次数。
// pickBoard 负责在切片之外，为登录用户补一行自己的真实排名。

const board = (n, start = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: start + i, username: `u${start + i}`, rank: i + 1 }));

test('P0 游客只拿到前 TOP_N 名，不额外补行', () => {
  const rows = board(60);
  const out = pickBoard(rows, null);
  assert.equal(out.length, 50);
  assert.equal(out[0].rank, 1);
  assert.equal(out[49].rank, 50);
});

test('P0 榜外登录用户被追加到末尾，且带 isSelf 标记', () => {
  const out = pickBoard(board(60), 60);
  assert.equal(out.length, 51);
  const me = out[out.length - 1];
  assert.equal(me.id, 60);
  assert.equal(me.isSelf, true);
  assert.equal(me.rank, 60, '追加行必须是真实名次，不能被误读为第 51 名');
});

test('P1 已在 TOP_N 内的用户不重复出现', () => {
  const out = pickBoard(board(60), 10);
  assert.equal(out.length, 50);
  assert.equal(out.filter((r) => r.id === 10).length, 1);
  assert.equal(out.every((r) => r.isSelf === undefined), true, '榜内行不打 isSelf 标记');
});

test('P2 用户不存在于榜单时原样返回，不产生脏数据', () => {
  const rows = board(3);
  const out = pickBoard(rows, 999);
  assert.equal(out.length, 3);
  assert.deepEqual(out, rows);
});

test('P2 空榜单不抛错', () => {
  assert.deepEqual(pickBoard([], 1), []);
});
