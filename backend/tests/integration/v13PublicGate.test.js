/**
 * v13 挂门牌与责任闭环 —— 集成测试（真实 HTTP + 真实 DB）
 *
 * 这一层对 v13 来说不是补充，而是**主战场**：
 *   1. RQ-159 邀请归因跨 `users` / `invite_codes` / `blind_sessions` 三张表，
 *      且「同一码二次注册不改写归属」是**外键与 UPDATE 语义**问题，纯函数测不到；
 *   2. RQ-157 的「看板 SQL 是否声明口径」只有对**真实源码**扫描才有意义，
 *      用 fixture 扫描等于自己给自己发通行证；
 *   3. RQ-158 的一致性对账本身就是 SQL 查询，单测里的假 rows 证明不了 SQL 能跑。
 *
 * 覆盖：RQ-156（责任人可断言）/ RQ-157（隔离自检）/ RQ-158（一致性对账）
 *      / RQ-159（邀请归因）/ RQ-160（验证留痕）/ RQ-172（冻结护栏）
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/index.js';
import pool from '../../src/db.js';
import { runMigrations } from '../../src/migrate.js';
import { seedStocks } from '../../src/seed.js';
import { loadMarket } from '../../src/market.js';
import { resetDb } from './resetDb.js';

import { checkTelemetryConsistency, recordVerification, verificationStreak, latestVerifications } from '../../src/services/releaseGateService.js';
import { planHistoricalMarks, applyHistoricalMarks, collectSourceFiles, scanMissingTestFilter } from '../../src/services/testIsolationService.js';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

let server;
let base;

before(async () => {
  await resetDb(pool);
  await runMigrations(pool);
  await seedStocks();
  await loadMarket();
  const app = createApp();
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
});

async function register({ channel = 'community', inviteCode = null, ua = null } = {}) {
  const username = `v13_${randomUUID().slice(0, 8)}`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ua ? { 'user-agent': ua } : {}) },
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      password: 'abc12345',
      channel,
      ...(inviteCode ? { inviteCode } : {}),
    }),
  });
  const d = await res.json();
  assert.equal(res.status, 200, `注册失败 ${JSON.stringify(d)}`);
  return { token: d.token, user: d.user, username };
}

const call = (path, { token, method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/* ================================================================== *
 * RQ-159 邀请归因                                                      *
 * ================================================================== */

test('P0 · RQ-159 注册携带邀请码时，用户行与邀请码行同时落定归因', async () => {
  const { token } = await register();
  const r = await call('/invite/codes', { token, method: 'POST', body: { count: 1, channel: 'community', label: '种子用户A' } });
  const created = await r.json();
  assert.equal(r.status, 201, JSON.stringify(created));
  const code = created.codes[0].code;
  assert.ok(code);

  // 手抄形态：小写 + 中间加连字符，归一化后必须仍是同一个码
  const { user } = await register({ inviteCode: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` });
  const { rows } = await pool.query('SELECT invite_code FROM users WHERE id=$1', [user.id]);
  assert.equal(rows[0].invite_code, code, '大小写/连字符写法必须归一到同一个码');

  const b = await pool.query('SELECT registered_user_id, registered_at FROM invite_codes WHERE code=$1', [code]);
  assert.equal(b.rows[0].registered_user_id, user.id);
  assert.ok(b.rows[0].registered_at, '绑定时间必须落库，否则无法判断邀请是否过期');
});

test('P0 · RQ-159 5 人注册 + 2 人有效完成即达成验收目标', async () => {
  const { token } = await register();
  // 漏斗是全局读数（不按登录者隔离）；先清干净，保证「5 人」这个数字是本用例造出来的
  await pool.query('DELETE FROM invite_codes');
  const r = await call('/invite/codes', { token, method: 'POST', body: { count: 5, channel: 'community' } });
  const codes = (await r.json()).codes.map((c) => c.code);

  const ids = [];
  for (const c of codes) {
    const { user } = await register({ inviteCode: c, channel: 'community' });
    ids.push(user.id);
  }
  // 前两人标记为有效完成：直接写 blind_sessions.effective_completed，
  // 与 RQ-147 落库的口径一致（漏斗读的就是这一列）
  for (const uid of ids.slice(0, 2)) {
    await pool.query(
      `INSERT INTO blind_sessions (user_id, stock_code, stock_name, alias, start_seq, end_seq, cursor_seq, status, effective_completed, finished_at)
       VALUES ($1,'600519','测试标的','标的 #T1',1,10,10,'FINISHED',TRUE, now())`,
      [uid]
    );
  }
  // 第三人只开训、未走完；第四、五人停在注册（这两类断点都必须能被定位）
  for (const uid of ids.slice(0, 3)) {
    await pool.query(`INSERT INTO analytics_events (user_id, event, payload, is_test) VALUES ($1,'blind_start','{}',FALSE)`, [uid]);
  }
  for (const uid of ids.slice(0, 2)) {
    await pool.query(`INSERT INTO analytics_events (user_id, event, payload, is_test) VALUES ($1,'blind_decision','{}',FALSE)`, [uid]);
  }

  const f = await call('/invite/funnel', { token });
  const d = await f.json();
  assert.equal(d.counts.registered, 5, '5 名外部用户注册');
  assert.equal(d.counts.started, 3, '三人开训（其中两人走完）');
  assert.equal(d.counts.effective, 2, '2 名有效完成');
  assert.equal(d.met, true, 'RQ-159 验收达成');
  assert.equal(d.paths.length, 5, '必须能逐人回访（5 份路径记录）');
  assert.equal(d.paths.filter((p) => p.dropAt === 'started').length, 2, '未开训的两人断点应定位到 started');
  assert.equal(d.paths.filter((p) => p.dropAt === 'decided').length, 1, '开训但未决策的那人断点应定位到 decided');
});

test('P1 · RQ-159 同一邀请码被第二人使用时不改写归属（否则按人回溯失效）', async () => {
  const { token } = await register();
  const code = (await (await call('/invite/codes', { token, method: 'POST', body: { count: 1 } })).json()).codes[0].code;
  const a = await register({ inviteCode: code });
  const b = await register({ inviteCode: code });
  const { rows } = await pool.query('SELECT registered_user_id FROM invite_codes WHERE code=$1', [code]);
  assert.equal(rows[0].registered_user_id, a.user.id, '归属应锁定第一个注册的人');
  // 第二个人仍然带上码（便于统计"这条链接带来了多少次注册"），但不抢占归属
  const ub = await pool.query('SELECT invite_code FROM users WHERE id=$1', [b.user.id]);
  assert.equal(ub.rows[0].invite_code, code);
});

test('P1 · RQ-159 邀请码列表接口可逐个回访，且需登录', async () => {
  const { token } = await register();
  await call('/invite/codes', { token, method: 'POST', body: { count: 2, label: '回访批次' } });
  const r = await call('/invite/codes', { token });
  const d = await r.json();
  assert.ok(d.codes.length >= 2);
  assert.ok(d.codes[0].code && Array.isArray(d.codes[0].steps));
  const anon = await call('/invite/codes');
  assert.equal(anon.status, 401, '邀请码含归因信息，必须登录');
});

test('P3 · RQ-159 非法邀请码不绑定也不让注册失败（归因不能拖垮注册）', async () => {
  const { user } = await register({ inviteCode: 'INV;DROP TABLE users' });
  const { rows } = await pool.query('SELECT invite_code FROM users WHERE id=$1', [user.id]);
  assert.equal(rows[0].invite_code, null);

  const { token } = await register();
  const bad = await call('/invite/bind', { token, method: 'POST', body: { code: '   ' } });
  assert.equal(bad.status, 400);
  const missing = await call('/invite/bind', { token, method: 'POST', body: { code: 'NOPE1234' } });
  assert.equal(missing.status, 400);
});

test('P3 · RQ-159 空库时邀请漏斗返回结构完整而非报错', async () => {
  const { token } = await register();
  await pool.query('DELETE FROM invite_codes');
  const r = await call('/invite/funnel', { token });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.met, false);
  assert.deepEqual(d.gap, { registered: 5, effective: 2 });
  assert.match(d.note, /尚未达成|断点/);
});

/* ================================================================== *
 * RQ-157 自测流量隔离                                                  *
 * ================================================================== */

test('P0 · RQ-157 自动化 UA 上报的埋点被自动判为测试流量，默认看板不可见', async () => {
  const { token, user } = await register();
  // 用自动化 UA 注册一个账号：这是压测脚本最典型的形态（v13 F-89：4521 条埋点全未标记）
  await pool.query('UPDATE users SET is_test = TRUE WHERE id = $1', [user.id]);

  const before = await (await call('/analytics/overview?days=30', { token })).json();
  assert.equal(before.scope, 'real', '默认口径必须是真实流量');
  const beforeStart = before.events.find((e) => e.event === 'blind_start')?.count || 0;

  // 真实用户（未打标）产生的埋点：track() 在写入侧判 is_test=FALSE
  const { rows: real } = await pool.query(
    `INSERT INTO analytics_events (user_id, event, payload, is_test)
     SELECT id, 'blind_start', '{}'::jsonb, FALSE FROM users WHERE is_test = FALSE ORDER BY id DESC LIMIT 1
     RETURNING id`
  );
  assert.equal(real.length, 1, '需要至少一名未打标用户');

  const after = await (await call('/analytics/overview?days=30', { token })).json();
  const afterStart = after.events.find((e) => e.event === 'blind_start')?.count || 0;
  assert.equal(afterStart, beforeStart + 1, '真实流量必须计入默认看板');

  // 打标用户的历史事件：口径为「事件未打标 且 用户未打标」，因此这一条不应进默认看板
  await pool.query(
    `INSERT INTO analytics_events (user_id, event, payload, is_test) VALUES ($1,'blind_start','{}',FALSE)`,
    [user.id]
  );
  const hidden = await (await call('/analytics/overview?days=30', { token })).json();
  assert.equal(
    hidden.events.find((e) => e.event === 'blind_start')?.count || 0,
    afterStart,
    '已打标用户的事件在默认看板中不可见'
  );

  const all = await (await call('/analytics/overview?days=30&scope=all', { token })).json();
  assert.equal(all.scope, 'all');
  assert.ok((all.events.find((e) => e.event === 'blind_start')?.count || 0) >= afterStart + 1, '全量口径应能看到它');
});

test('P0 · RQ-157 隔离自检端点同时给出三件套，且真实源码零缺失口径', async () => {
  const { token } = await register();
  const r = await call('/analytics/isolation', { token });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d).slice(0, 300));
  assert.ok(d.scope, '必须给出分口径计数');
  assert.equal(typeof d.scope.test, 'number');
  assert.ok(d.dedupe, '必须给出 resume 去重读数');
  assert.ok(d.scan, '必须给出源码扫描结果');

  // 对**真实源码**扫描（不是 fixture）：这是唯一能防止下一个人再加看板时忘记过滤的机制
  const files = collectSourceFiles({ root: SRC_ROOT, readFn: readFileSync, readdirFn: readdirSync, joinFn: join });
  const scan = scanMissingTestFilter(files);
  assert.ok(files.length > 20, `扫描文件数异常：${files.length}`);
  assert.equal(scan.ok, true, `存在未声明流量口径的读点：${JSON.stringify(scan.offenders)}`);
  assert.ok(scan.checked > 0);
});

test('P0 · RQ-157 历史 blind_resume 重复可被打标，打标后去重违规归零', async () => {
  const { user } = await register();
  const sid = 900001;
  for (let i = 0; i < 3; i += 1) {
    await pool.query(
      `INSERT INTO analytics_events (user_id, event, payload, is_test)
       VALUES ($1,'blind_resume',$2::jsonb,FALSE)`,
      [user.id, JSON.stringify({ sessionId: String(sid) })]
    );
  }
  const before = await planHistoricalMarks({ queryFn: (sql, params) => pool.query(sql, params) });
  assert.ok(before.resumeDup >= 2, `应识别出重复 resume：${JSON.stringify(before)}`);

  const unauth = await call('/analytics/isolation/backfill', { method: 'POST', body: { apply: false } });
  assert.equal(unauth.status, 401, '打标接口必须登录，匿名请求不得生效');

  const applied = await applyHistoricalMarks({ queryFn: (sql, params) => pool.query(sql, params), apply: true });
  assert.equal(applied.applied, true);
  assert.ok(applied.changed.resumeDup >= 2, '重复项应被打标');

  // 打标后：未打标的同会话 resume 只剩 1 条
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM analytics_events
      WHERE event='blind_resume' AND is_test=FALSE AND payload->>'sessionId'=$1`,
    [String(sid)]
  );
  assert.equal(rows[0].c, 1, '重复项被打标后，真实口径只剩最早一条');
  assert.equal(applied.changed.resumeDup + 1, 3, '3 条中标记 2 条');
});

test('P3 · RQ-157 打标接口默认 dry-run，不改动任何数据', async () => {
  const { token } = await register();
  const before = await pool.query(`SELECT COUNT(*)::int AS c FROM analytics_events WHERE is_test=TRUE`);
  const r = await call('/analytics/isolation/backfill', { token, method: 'POST', body: { apply: false } });
  const d = await r.json();
  assert.equal(d.applied, false);
  assert.equal(d.dryRun, true);
  const after = await pool.query(`SELECT COUNT(*)::int AS c FROM analytics_events WHERE is_test=TRUE`);
  assert.equal(after.rows[0].c, before.rows[0].c, 'dry-run 不得改动数据');
});

/* ================================================================== *
 * RQ-158 埋点与业务表一致性                                            *
 * ================================================================== */

test('P0 · RQ-158 注入一条孤立 blind_finish 后对账失败，清理后恢复', async () => {
  const q = (sql, params) => pool.query(sql, params);
  // 先把本文件其它用例造成的差异清掉：对账是**全局读数**，不按登录者隔离
  await pool.query(`DELETE FROM analytics_events WHERE event='blind_finish'`);
  await pool.query(`DELETE FROM blind_sessions WHERE alias LIKE '标的 #T%'`);
  await pool.query(
    `INSERT INTO analytics_events (user_id, event, payload, is_test)
     VALUES (NULL,'blind_finish',$1::jsonb,FALSE)`,
    [JSON.stringify({ sessionId: '888888' })]
  );
  const bad = await checkTelemetryConsistency({ queryFn: q, days: 3650 });
  assert.equal(bad.ok, false, '埋点记了不存在的会话，必须被报出来');
  assert.ok(bad.consistency.orphanEvents.some((x) => x.sessionId === 888888));

  await pool.query(`DELETE FROM analytics_events WHERE event='blind_finish' AND payload->>'sessionId'='888888'`);
  const good = await checkTelemetryConsistency({ queryFn: q, days: 3650 });
  assert.equal(good.ok, true, `清理后应对账一致：${good.detail}`);
});

test('P0 · RQ-158 会话已结算但无埋点时判为漏报', async () => {
  const q = (sql, params) => pool.query(sql, params);
  const { user } = await register();
  await pool.query(
    `INSERT INTO blind_sessions (user_id, stock_code, stock_name, alias, start_seq, end_seq, cursor_seq, status, effective_completed, finished_at)
     VALUES ($1,'600519','测试标的','标的 #T9',1,10,10,'FINISHED',TRUE, now())`,
    [user.id]
  );
  const r = await checkTelemetryConsistency({ queryFn: q, days: 3650 });
  assert.equal(r.ok, false);
  assert.ok(r.consistency.missingEvents.length >= 1, '会话已结算但缺 blind_finish 埋点应被识别');
});

/* ================================================================== *
 * RQ-160 发布验证留痕 / RQ-156 责任人 / RQ-172 冻结                     *
 * ================================================================== */

test('P0 · RQ-160 发布验证记录落库并可统计连续次数', async () => {
  const q = (sql, params) => pool.query(sql, params);
  await pool.query(`DELETE FROM release_verifications WHERE git_commit LIKE 'v13-test-%'`);
  const a = await recordVerification({ queryFn: q, gitCommit: 'v13-test-aaa', baseUrl: 'http://127.0.0.1', report: { ok: true, results: [{ name: 'x', ok: true }] } });
  assert.equal(a.recorded, true);
  const b = await recordVerification({ queryFn: q, gitCommit: 'v13-test-bbb', baseUrl: 'http://127.0.0.1', report: { ok: true, results: [{ name: 'x', ok: true }] } });
  assert.equal(b.recorded, true);

  const { rows } = await latestVerifications({ queryFn: q, limit: 10 });
  const s = verificationStreak(rows);
  assert.equal(s.streak >= 2, true, `连续验证次数应 ≥2，实际 ${s.streak}`);
  assert.equal(s.ok, true);
  await pool.query(`DELETE FROM release_verifications WHERE git_commit LIKE 'v13-test-%'`);
});

test('P1 · RQ-160 一次未通过即打断连续（"跑过但没过"不算已验证）', async () => {
  const q = (sql, params) => pool.query(sql, params);
  const rows = [
    { git_commit: 'v13x1', ok: true },
    { git_commit: 'v13x2', ok: false },
    { git_commit: 'v13x3', ok: true },
  ];
  assert.equal(verificationStreak(rows).streak, 1);
  assert.equal(verificationStreak(rows).ok, false);
});

test('P1 · RQ-156/172 公网自检端点同时给出责任人状态与冻结护栏', async () => {
  const r = await fetch(`${base}/public/access`);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.ok(d.owner, '必须给出责任人状态');
  assert.ok(['none', 'no-owner', 'no-deadline', 'overdue', 'due-soon', 'ok'].includes(d.owner.state));
  assert.ok(d.gate, '必须给出冻结护栏');
  assert.equal(typeof d.gate.ok, 'boolean');
  assert.ok(Array.isArray(d.gate.frozen));

  const g = await (await fetch(`${base}/public/gate?rq=RQ-161,RQ-156`)).json();
  assert.equal(g.frozenList.length, 10);
  if (g.publicReady === false) {
    assert.deepEqual(g.blocked, ['RQ-161']);
    assert.deepEqual(g.allowed, ['RQ-156']);
  } else {
    assert.equal(g.blocked.length, 0);
  }
});

test('P3 · RQ-156 公网未就绪时自检端点给出可执行命令而非只报错', async () => {
  const d = await (await fetch(`${base}/public/access`)).json();
  if (!d.ready) {
    assert.ok(Array.isArray(d.blockers) && d.blockers.length > 0);
    assert.match(d.provision || '', /provisionPublicEntry/, '未就绪时应给出一条命令，而不是让人自己拼');
  }
});
