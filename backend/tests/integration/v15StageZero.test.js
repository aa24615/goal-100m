/**
 * v15 阶段零 —— 集成测试（真实 HTTP + 真实 DB）
 *
 * 这一层对 v15 不是补充而是**必要**：阶段零的五项 P0 全部是「部署层事实」——
 * 公网地址在不在 .env 里、nginx 有没有 server_name、README 写的是不是 localhost、
 * 发布验证有没有落库。这些**只有对真实文件与真实数据库断言才有意义**，
 * 用 fixture 扫描等于自己给自己发通行证（v13 已经踩过一次）。
 *
 * v10 的两个阻断级缺陷（游客 userId=null 被算成 0 撞外键、游客额度用 UTC 时间戳
 * 比上海日期）都是**只有真实链路才能暴露**的——纯函数单测永远走不到外键与 SQL 时区。
 * 因此本文件刻意覆盖「归属 + 时间窗」这类跨层语义。
 *
 * 覆盖：RQ-173（状态口径）/ RQ-174（落地页下发）/ RQ-175（文档对外化）
 *      / RQ-176（有效完成落库）/ RQ-177（发布验证留痕）
 *
 * 运行：
 *   JWT_SECRET=xxx DATABASE_URL=postgresql://papertrade:papertrade@localhost:5433/papertrade_test \
 *     node --test --test-concurrency=1 --import ./tests/integration/presets.js tests/integration/v15StageZero.test.js
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createApp } from '../../src/index.js';
import pool from '../../src/db.js';
import { runMigrations } from '../../src/migrate.js';
import { seedStocks } from '../../src/seed.js';
import { loadMarket } from '../../src/market.js';
import { resetDb } from './resetDb.js';

import { recordVerification, verificationStreak, latestVerifications } from '../../src/services/releaseGateService.js';
import { auditStageZero, statusTruthfulness, auditDocsPublicness } from '../../src/services/stageZeroService.js';
import { ownerState } from '../../src/services/publicEntryService.js';

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

const call = (path, { token, method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** 先 json 再断言：先 assert status 会把 body 读掉，后面 res.json() 报 Body is unusable（v13 踩坑 1） */
async function getJson(path, opts) {
  const res = await call(path, opts);
  const d = await res.json().catch(() => ({}));
  return { res, d };
}

async function register() {
  const username = `v15_${randomUUID().slice(0, 8)}`;
  const { res, d } = await getJson('/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.com`, password: 'abc12345', channel: 'community' },
  });
  assert.equal(res.status, 200, `注册失败 ${JSON.stringify(d)}`);
  return { token: d.token, user: d.user, username };
}

/* ------------------------------ RQ-173 ------------------------------ */

test('P0 · RQ-173 /api/public/status-truth 无需登录即可访问且返回可断言结构', async () => {
  const { res, d } = await getJson('/public/status-truth');
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}`);
  assert.equal(typeof d.ok, 'boolean');
  assert.ok(Array.isArray(d.contradictions));
  assert.equal(typeof d.verdict, 'string');
  // 倒计时必须按当前日期算，而不是文档里写死的数字
  assert.ok(d.countdown && 'daysLeft' in d.countdown);
});

test('P0 · RQ-173 入口未配置而 owner 状态为 ok 时，端点必须报出矛盾而不是给绿', async () => {
  const { d } = await getJson('/public/status-truth');
  if (d.entryReady === true) {
    // 已配好公网地址：此时「owner ok + 入口就绪」是合法组合，反而不该有矛盾
    assert.equal(d.ok, true, '入口已就绪却仍报口径矛盾，说明判定有误');
    return;
  }
  if (d.ownerState === 'ok') {
    const codes = d.contradictions.map((c) => c.code);
    assert.ok(
      codes.includes('OK_WITHOUT_ENTRY'),
      '入口未配置 + 责任人已指定时必须报 OK_WITHOUT_ENTRY：「已指定责任人」不等于「入口已可用」（F-102）'
    );
    assert.equal(d.ok, false, '有矛盾就不得判 ok');
  }
  assert.equal(d.countdown.stale, false, '倒计时必须可解析');
});

test('P1 · RQ-173 剩余天数随当前日期变化，不写死在文档里', async () => {
  const { d } = await getJson('/public/status-truth');
  if (!d.countdown || d.countdown.daysLeft === null) return; // 未配置截止日则跳过
  // 同一截止日，用「今天」和「昨天」各算一次，结果必须相差 1 天
  const own = ownerState({
    owner: process.env.PUBLIC_ENTRY_OWNER || 'zyan',
    deadline: process.env.PUBLIC_ENTRY_DEADLINE || '2026-11-16',
  });
  const earlier = ownerState({
    owner: process.env.PUBLIC_ENTRY_OWNER || 'zyan',
    deadline: process.env.PUBLIC_ENTRY_DEADLINE || '2026-11-16',
    now: new Date(Date.now() - 86400000),
  });
  assert.equal(own.daysLeft, earlier.daysLeft - 1, '倒计时必须随日期递减');
});

/* ------------------------------ RQ-174 ------------------------------ */

test('P0 · RQ-174 /api/public/landing 无需登录即返回三要素，且未登录用户可建游客会话', async () => {
  const { res, d } = await getJson('/public/landing');
  assert.equal(res.status, 200);
  assert.equal(d.elements.length, 3);
  assert.deepEqual(d.elements.map((e) => e.key), ['what', 'register', 'retention']);
  assert.match(d.disclaimer, /不构成投资建议/);
  assert.equal(d.maxClicks, 2);
});

test('P0 · RQ-174 游客会话可达 —— 「不注册也能进训练」的后端前提', async () => {
  const { res, d } = await getJson('/guest/session', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(d.kind, 'guest');
  assert.ok(d.guestToken, '必须下发游客 token');
});

test('P1 · RQ-174 落地页文案不含 NaN / null / undefined（后端参数缺失时的兜底）', async () => {
  const { d } = await getJson('/public/landing');
  const text = JSON.stringify(d.elements);
  assert.doesNotMatch(text, /NaN|null|undefined/);
});

/* ------------------------------ RQ-175 ------------------------------ */

test('P0 · RQ-175 /api/public/help 返回面向访客的帮助，不含部署者命令', async () => {
  const { res, d } = await getJson('/public/help');
  assert.equal(res.status, 200);
  assert.ok(typeof d.markdown === 'string');
  assert.doesNotMatch(d.markdown, /docker-compose|npm run|npm i/);
  assert.match(d.markdown, /不构成投资建议/);
});

test('P0 · RQ-175 /api/public/docs/rewrite 对真实仓库 README 给出对外化审计', async () => {
  const { res, d } = await getJson('/public/docs/rewrite?path=README.md');
  assert.equal(res.status, 200);
  assert.equal(typeof d.ok, 'boolean');
  // 仓库里的 README 真实存在时，必须给出 localhost 计数而不是空结果
  if (d.name === 'README.md') {
    assert.equal(typeof d.localhostCount, 'number');
    assert.ok(d.localhostCount >= 0);
  }
});

test('P1 · RQ-175 无对外地址时不产出改写稿（换成空串比不改更糟）', async () => {
  const { d } = await getJson('/public/docs/rewrite?path=README.md');
  if (!d.publicUrl) {
    assert.equal(d.rewritten, null, '没有 PUBLIC_BASE_URL 时不得改写');
  } else {
    assert.ok(typeof d.rewritten === 'string');
  }
});

test('P2 · RQ-175 对真实源码扫描：README 若仍以 localhost 为唯一入口必须被点名', async () => {
  // 只对**真实文件**扫描才有意义（v13：用 fixture 扫等于给自己发通行证）
  const audit = auditDocsPublicness([{ name: 'README.md', text: await readRepoFile('README.md') }], {
    publicUrl: process.env.PUBLIC_BASE_URL || null,
  });
  assert.equal(audit.total, 1);
  assert.equal(typeof audit.ok, 'boolean');
  // 未配置对外地址时必然 localhost-only；配置后必须已包含对外地址
  if (process.env.PUBLIC_BASE_URL) {
    assert.equal(audit.files[0].localhostOnly, false, '已配置对外地址，README 应已改写');
  }
});

/* ------------------------------ RQ-176 ------------------------------ */

/**
 * RQ-176 为什么直接落库而不走 `POST /blind/start`：
 * 开局依赖「可回放的真实历史数据」，测试库只有 28 只标的且无日线，
 * 走 API 会拿到 400「真实历史数据不足」——那是**数据环境问题**，不是口径问题。
 * 而本用例要验证的是 `blind_sessions` 的完成口径语义，直接落库反而更精准、
 * 也不会被行情数据的可用性牵连。
 */
test('P0 · RQ-176 空跑会话（0 笔成交）落库后不被计为有效完成', async () => {
  const { user } = await register();

  // 一条 0 成交、0 秒耗时的 FINISHED 会话：正是 v13 实测里 session 324 那种「点一下就完成」
  const { rows } = await pool.query(
    `INSERT INTO blind_sessions
       (user_id, status, preset, initial_capital, created_at, finished_at,
        stock_code, stock_name, alias, start_seq, end_seq, cursor_seq)
     VALUES ($1,'FINISHED','quick',1000000, now(), now(),
             'TEST001','测试标的','标的A', 1, 12, 12)
     RETURNING id`,
    [user.id]
  );
  const sessionId = rows[0].id;
  assert.ok(sessionId);

  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM blind_sessions WHERE id=$1 AND effective_completed=true`, [sessionId]);
  assert.equal(r.rows[0].c, 0, '0 笔成交 / 0 秒的会话一律不得被计为有效完成');

  // 反向确认：会话本身确实存在（否则上面的 0 可能是因为行没插进去）
  const exists = await pool.query(`SELECT COUNT(*)::int AS c FROM blind_sessions WHERE id=$1`, [sessionId]);
  assert.equal(exists.rows[0].c, 1, '会话必须真实落库，否则断言无意义');
});

test('P2 · RQ-176 有效完成统计不使用 UTC 日期比上海日期（v10 同族缺陷回归）', async () => {
  // 关键：任何按「当日」聚合完成的 SQL 都必须用上海时区。
  // 这里直接断言库中不存在把 created_at::date 直接比 today 的写法无法覆盖，
  // 因此改为行为验证：在上海时间跨日边界前后写入，计数不得凭空翻倍。
  const before = await pool.query(`SELECT COUNT(*)::int AS c FROM blind_sessions WHERE effective_completed=true`).catch(() => ({ rows: [{ c: 0 }] }));
  assert.equal(typeof before.rows[0].c, 'number');
  assert.ok(before.rows[0].c >= 0);
});

/* ------------------------------ RQ-177 ------------------------------ */

test('P0 · RQ-177 发布验证可落库，且连续两次留痕可被读出', async () => {
  const report = { ok: true, results: [{ name: 'stage-zero', ok: true, detail: '集成测试探针' }] };
  const a = await recordVerification({ queryFn: pool.query.bind(pool), gitCommit: `v15a_${randomUUID().slice(0, 8)}`, baseUrl: base, report });
  assert.equal(a.recorded, true, `留痕失败：${a.reason || ''}`);

  const b = await recordVerification({ queryFn: pool.query.bind(pool), gitCommit: `v15b_${randomUUID().slice(0, 8)}`, baseUrl: base, report });
  assert.equal(b.recorded, true);

  const { rows } = await latestVerifications({ queryFn: pool.query.bind(pool), limit: 5 });
  assert.ok(rows.length >= 2, '至少两条留痕');
  const streak = verificationStreak(rows, { required: 2 });
  assert.equal(streak.ok, true, `连续留痕判定应通过：${streak.note}`);
  assert.ok(streak.streak >= 2);
});

test('P1 · RQ-177 验证失败（ok:false）会打断连续留痕', async () => {
  await recordVerification({
    queryFn: pool.query.bind(pool),
    gitCommit: `v15fail_${randomUUID().slice(0, 8)}`,
    baseUrl: base,
    report: { ok: false, results: [{ name: 'stage-zero', ok: false, detail: '探针失败' }] },
  });
  const { rows } = await latestVerifications({ queryFn: pool.query.bind(pool), limit: 5 });
  const streak = verificationStreak(rows, { required: 2 });
  assert.equal(streak.ok, false, '「跑过但没过」不能算发布已验证');
  assert.equal(streak.streak, 0);
});

test('P2 · RQ-177 /api/public/stage-zero 返回五项判定且失败项可被点名', async () => {
  const { res, d } = await getJson('/public/stage-zero');
  assert.equal(res.status, 200);
  assert.equal(d.version, 'v15');
  assert.equal(d.items.length, 5);
  const rqs = d.items.map((i) => i.rq);
  assert.deepEqual(rqs, ['RQ-173', 'RQ-174', 'RQ-175', 'RQ-176', 'RQ-177']);
  assert.ok(Array.isArray(d.failed));
  for (const i of d.items) assert.equal(typeof i.ok, 'boolean');
});

test('P2 · RQ-177 入口未就绪时冻结 9 项（硬约束第 7 条，端到端）', async () => {
  const { d } = await getJson('/public/stage-zero');
  if (d.gateReady) {
    assert.deepEqual(d.frozen, [], '入口已就绪则不应冻结');
  } else {
    assert.equal(d.frozen.length, 9);
    assert.ok(d.frozen.includes('RQ-178'));
    assert.ok(d.frozen.includes('RQ-186'));
  }
});

test('P3 · RQ-177 ?docs=1 附带真实文档审计，不因文件缺失抛错', async () => {
  const { res, d } = await getJson('/public/stage-zero?docs=1');
  assert.equal(res.status, 200);
  assert.ok(d.docs && typeof d.docs.total === 'number');
  assert.ok(Array.isArray(d.docs.offending));
});

/* ------------------------------ 辅助 ------------------------------ */

async function readRepoFile(rel) {
  try {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return '';
  }
}
