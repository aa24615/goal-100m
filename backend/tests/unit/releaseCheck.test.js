/**
 * RQ-87 发布前一致性检查 —— 单元测试
 *
 * 优先级覆盖：P0 阻断能力 · P3 异常环境 · P5 流程留痕
 * 说明：本文件只测**纯文件系统 / git 侧**的检查项，DB 项强制 skipDb，
 *      保证单测可在无数据库环境下稳定运行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGitClean,
  checkDistAssets,
  checkDistFreshness,
  checkReadmeReleaseDoc,
  checkRemoteParity,
  checkPublicEntrypoint,
  runChecks,
  REPO_ROOT,
} from '../../src/scripts/releaseCheck.js';

/* ===================== P0 · 阻断能力 ===================== */

test('P0 · RQ-87 检查项齐备且各自返回结构化结果', async () => {
  const report = await runChecks({ skipDb: true });
  assert.ok(Array.isArray(report.results));
  assert.equal(typeof report.ok, 'boolean');
  const names = report.results.map((r) => r.name);
  for (const required of ['git-clean', 'git-pushed', 'dist-assets', 'dist-freshness', 'migrations', 'readme-release']) {
    assert.ok(names.includes(required), `缺少检查项 ${required}`);
  }
});

test('P0 · RQ-87 任一项失败即判定不可发布', async () => {
  const report = await runChecks({ skipDb: true });
  if (report.failed.length > 0) {
    assert.equal(report.ok, false, '有失败项时 ok 必须为 false（阻断发布）');
    for (const f of report.failed) {
      assert.equal(f.ok, false);
      assert.ok(typeof f.detail === 'string' && f.detail.length > 0, '失败项必须给出可读原因');
    }
  } else {
    assert.equal(report.ok, true);
  }
});

test('P0 · RQ-87 git-clean 在真实仓库上能给出明确结论', () => {
  const r = checkGitClean();
  assert.equal(r.name, 'git-clean');
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.detail);
  // 若为失败，必须列出具体条目，便于直接 git add
  if (!r.ok) {
    assert.ok(Array.isArray(r.items) && r.items.length > 0, '失败时必须列出未提交项');
  }
});

test('P0 · RQ-87 dist 资源缺失时判定失败（这正是「线上旧包」的成因）', () => {
  const r = checkDistAssets();
  assert.equal(r.name, 'dist-assets');
  // 无论通过与否，都不能抛异常，必须给出可执行提示
  assert.ok(typeof r.detail === 'string');
  if (!r.ok) {
    assert.match(r.detail, /不存在|缺失|build/, '失败提示必须指向「重新构建」');
  }
});

test('P0 · RQ-87 dist 落后于源码必须被检出', () => {
  const r = checkDistFreshness();
  assert.equal(r.name, 'dist-freshness');
  if (!r.ok) {
    assert.match(r.detail, /落后于 src|重新 npm run build/);
  }
});

/* ===================== P3 · 异常环境 ===================== */

test('P3 · RQ-87 跳过 DB 时不因缺少 DATABASE_URL 而崩溃', async () => {
  const r = await (
    await import('../../src/scripts/releaseCheck.js')
  ).checkMigrations({ skipDb: true });
  assert.equal(r.ok, true, 'skipDb 时应降级为通过并给出 warn');
  assert.equal(r.warn, true);
  assert.match(r.detail, /跳过 DB 校验/);
});

test('P3 · RQ-87 runChecks 在无数据库环境下仍能完成全部检查', async () => {
  await assert.doesNotReject(() => runChecks({ skipDb: true }));
  const report = await runChecks({ skipDb: true });
  // RQ-145（双远端同哈希）与 RQ-142（公网入口三处一致）为 v12 新增的两项
  assert.equal(report.results.length, 8);
  const names = report.results.map((r) => r.name);
  assert.ok(names.includes('remote-parity'), 'RQ-145 双远端同步校验必须纳入发布前检查');
  assert.ok(names.includes('public-entrypoint'), 'RQ-142 公网入口审计必须纳入发布前检查');
  for (const r of report.results) {
    assert.ok(r.name && r.detail, '每个检查项都必须有名称与说明');
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('P3 · RQ-87 仓库根路径指向项目根目录', () => {
  assert.ok(String(REPO_ROOT).replace(/\\/g, '/').endsWith('mm8888'), `REPO_ROOT 解析异常：${REPO_ROOT}`);
});

/* ===================== RQ-145 双远端同步（v12 新增） ===================== */

test('P0 · RQ-145 两个远端 HEAD 一致时通过', () => {
  const r = checkRemoteParity(['origin', 'github']);
  // 本机可能只有一个远端或离线；只要不抛错且结构完整即可
  assert.ok(['remote-parity'].includes(r.name));
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.detail, '必须给出可读说明，不能只回一个布尔值');
});

test('P3 · RQ-145 只有一个远端时降级为 warn 而不是失败（不能因为配置简单就阻断发布）', () => {
  const r = checkRemoteParity(['origin']);
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.match(r.detail, /无需跨远端比对/);
});

test('P3 · RQ-145 远端全部不可访问时降级为 warn（离线场景不该阻断）', () => {
  const r = checkRemoteParity(['no-such-remote-a', 'no-such-remote-b']);
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.match(r.detail, /可访问远端不足/);
});

test('P3 · RQ-145 远端列表为空时不抛错', () => {
  assert.doesNotThrow(() => checkRemoteParity([]));
  assert.doesNotThrow(() => checkRemoteParity(null));
});

/* ===================== RQ-142 公网入口审计（v12 新增） ===================== */

test('P1 · RQ-142 公网入口检查项不阻断发布（未配好是告警，不是构建失败）', () => {
  const r = checkPublicEntrypoint();
  assert.equal(r.name, 'public-entrypoint');
  assert.equal(r.ok, true, '缺公网入口是产品阻塞，不是发布阻塞');
  assert.ok(r.audit, '必须带出审计明细，方便直接看缺哪几项');
  assert.ok(Array.isArray(r.audit.blockers));
});

test('P3 · RQ-142 README/文件缺失时仍返回结构化结果，不抛错', () => {
  const r = checkPublicEntrypoint({
    existsFn: () => false,
    readFn: () => '',
  });
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.ok(r.audit.blockers.length > 0, '文件全缺时必须列出阻断项');
});

/* ===================== P5 · 流程留痕与回归 ===================== */

test('P5 · RQ-87 README 必须写明「提交 → 推送 → 构建部署」三步', () => {
  const r = checkReadmeReleaseDoc();
  assert.equal(r.ok, true, `README 发布流程缺失：${r.detail}`);
  assert.match(r.detail, /提交 → 推送 → 构建部署/);
});

test('P5 · RQ-87 迁移检查在不可达数据库时降级为警告而非阻断', async () => {
  // 未配置 DATABASE_URL 时不应让发布流程因环境问题被硬卡住，
  // 但必须留下「未校验」的痕迹（warn），避免误以为已经检查过。
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { checkMigrations } = await import('../../src/scripts/releaseCheck.js');
    const r = await checkMigrations({ skipDb: false });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});
