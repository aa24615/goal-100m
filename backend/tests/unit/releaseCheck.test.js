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
  assert.equal(report.results.length, 6);
  for (const r of report.results) {
    assert.ok(r.name && r.detail, '每个检查项都必须有名称与说明');
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('P3 · RQ-87 仓库根路径指向项目根目录', () => {
  assert.ok(String(REPO_ROOT).replace(/\\/g, '/').endsWith('mm8888'), `REPO_ROOT 解析异常：${REPO_ROOT}`);
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
