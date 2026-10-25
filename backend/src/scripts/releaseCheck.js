/**
 * RQ-87 发布前一致性检查（仓库 = 构建产物 = 线上）
 *
 * 为什么要有这个脚本：本项目已经**两次**出现「生产 ≠ 仓库」（v6 补交一次、v7 又来一次），
 * 表现形式永远是同一个：代码在仓库里、测试全绿，但线上跑的是旧镜像、新接口 404。
 * 靠人记住「先 build 再 up」是不可靠的，因此固化成可执行的检查，不通过就退出码 1。
 *
 * 检查项：
 *   1. git 工作区干净（已改未提交 / 未跟踪新文件都会导致镜像里缺代码）
 *   2. 本地 HEAD 已推送到全部远端（否则换机即丢）
 *   3. frontend/dist 存在，且 index.html 引用的资源文件真实存在
 *   4. dist 不落后于 src（改了源码但没重新 build，是本次价值黑洞的直接成因）
 *   5. 迁移文件数 ≤ 已应用迁移数（可选，需要 DATABASE_URL）
 *   6. README 写明发布三步顺序（流程留痕，硬约束 2）
 *
 * 用法：node src/scripts/releaseCheck.js [--json] [--skip-db]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** backend/src/scripts → 仓库根 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function git(args, cwd = REPO_ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  }
}

function newestMtime(dir, exts) {
  let max = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        const m = statSync(p).mtimeMs;
        if (m > max) max = m;
      }
    }
  };
  walk(dir);
  return max;
}

/* ------------------------------ 各检查项 ------------------------------ */

/** 1. 工作区干净 */
export function checkGitClean() {
  const out = git(['status', '--porcelain']);
  if (out == null) return { name: 'git-clean', ok: false, detail: '无法执行 git status（非 git 仓库或 git 不可用）' };
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 0) {
    return {
      name: 'git-clean',
      ok: false,
      detail: `工作区有 ${lines.length} 个未提交项（前 5 条）：${lines.slice(0, 5).join(' | ')}`,
      items: lines,
    };
  }
  return { name: 'git-clean', ok: true, detail: '工作区干净' };
}

/** 2. HEAD 已推送到全部远端 */
export function checkPushed() {
  const head = (git(['rev-parse', 'HEAD']) || '').trim();
  if (!head) return { name: 'git-pushed', ok: false, detail: '无法获取本地 HEAD' };
  const remotes = (git(['remote']) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (remotes.length === 0) return { name: 'git-pushed', ok: false, detail: '未配置任何远端' };

  const missing = [];
  for (const r of remotes) {
    const remoteHead = (git(['ls-remote', r, 'HEAD']) || '').split('\n')[0]?.split(/\s+/)[0]?.trim();
    if (!remoteHead) {
      missing.push(`${r}(无法访问)`);
    } else if (remoteHead !== head) {
      missing.push(`${r}(远端 ${remoteHead.slice(0, 8)} ≠ 本地 ${head.slice(0, 8)})`);
    }
  }
  // ls-remote 走网络，取不到时不阻断发布（离线场景），但明确提示
  if (missing.length > 0 && missing.every((m) => m.includes('无法访问'))) {
    return { name: 'git-pushed', ok: true, warn: true, detail: `远端不可访问，跳过比对：${missing.join(', ')}` };
  }
  if (missing.length > 0) {
    return { name: 'git-pushed', ok: false, detail: `本地 HEAD 未同步到：${missing.join(', ')}` };
  }
  return { name: 'git-pushed', ok: true, detail: `HEAD ${head.slice(0, 8)} 已同步到 ${remotes.join(', ')}` };
}

/** 3. dist 存在且 index.html 引用的资源真实存在 */
export function checkDistAssets() {
  const distDir = join(REPO_ROOT, 'frontend', 'dist');
  const indexHtml = join(distDir, 'index.html');
  if (!existsSync(indexHtml)) {
    return { name: 'dist-assets', ok: false, detail: 'frontend/dist/index.html 不存在，请先执行 npm run build' };
  }
  const html = readFileSync(indexHtml, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  if (refs.length === 0) {
    return { name: 'dist-assets', ok: false, detail: 'index.html 未引用任何 /assets 资源，构建可能失败' };
  }
  const missing = refs.filter((r) => !existsSync(join(distDir, r.replace(/^\//, ''))));
  if (missing.length > 0) {
    return { name: 'dist-assets', ok: false, detail: `index.html 引用的资源缺失：${missing.join(', ')}` };
  }
  return { name: 'dist-assets', ok: true, detail: `index.html 引用 ${refs.length} 个资源，全部存在` };
}

/**
 * 4. dist 不落后于 src
 * 前端 Dockerfile 只 COPY 预构建产物，改了源码不重新 build 就等于没改。
 */
export function checkDistFreshness() {
  const distDir = join(REPO_ROOT, 'frontend', 'dist');
  const srcDir = join(REPO_ROOT, 'frontend', 'src');
  if (!existsSync(srcDir)) return { name: 'dist-freshness', ok: false, detail: 'frontend/src 不存在' };
  if (!existsSync(distDir)) return { name: 'dist-freshness', ok: false, detail: 'frontend/dist 不存在，请先构建' };

  const distM = newestMtime(distDir, ['.js', '.css', '.html']);
  const srcM = newestMtime(srcDir, ['.ts', '.tsx', '.css', '.js']);
  if (!distM || !srcM) return { name: 'dist-freshness', ok: true, warn: true, detail: '无法比较时间戳，跳过' };
  if (distM < srcM) {
    return {
      name: 'dist-freshness',
      ok: false,
      detail: `dist 落后于 src（dist ${new Date(distM).toISOString()} < src ${new Date(srcM).toISOString()}），请重新 npm run build`,
    };
  }
  return { name: 'dist-freshness', ok: true, detail: 'dist 不落后于源码' };
}

/** 5. 迁移文件 vs 已应用迁移（需要 DATABASE_URL，且能连上库） */
export async function checkMigrations({ skipDb = false } = {}) {
  const dir = join(REPO_ROOT, 'backend', 'migrations');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    return { name: 'migrations', ok: false, detail: 'backend/migrations 目录不可读' };
  }

  if (skipDb || !process.env.DATABASE_URL) {
    return { name: 'migrations', ok: true, warn: true, detail: `跳过 DB 校验（${files.length} 个迁移文件，未配置 DATABASE_URL）` };
  }
  try {
    const { default: pool } = await import('../db.js');
    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => String(r.version)));
    const pending = files
      .map((f) => f.replace(/\.sql$/, ''))
      .filter((v) => !applied.has(v) && !applied.has(v.replace(/^(\d+)_.*/, '$1')));
    if (pending.length > 0) {
      return { name: 'migrations', ok: false, detail: `未应用迁移 ${pending.length} 个：${pending.join(', ')}` };
    }
    return { name: 'migrations', ok: true, detail: `${files.length} 个迁移文件全部已应用` };
  } catch (e) {
    return { name: 'migrations', ok: true, warn: true, detail: `数据库不可达，跳过：${e?.message || e}` };
  }
}

/** 6. README 写明发布三步顺序（硬约束 2 的流程留痕） */
export function checkReadmeReleaseDoc() {
  const p = join(REPO_ROOT, 'README.md');
  if (!existsSync(p)) return { name: 'readme-release', ok: false, detail: 'README.md 不存在' };
  const md = readFileSync(p, 'utf8');
  const hasCommit = /git commit/.test(md);
  const hasPush = /git push/.test(md);
  const hasBuild = /npm run build|docker compose up/.test(md);
  if (!hasCommit || !hasPush || !hasBuild) {
    return {
      name: 'readme-release',
      ok: false,
      detail: `README 未完整写明发布三步（commit:${hasCommit} push:${hasPush} build:${hasBuild}）`,
    };
  }
  return { name: 'readme-release', ok: true, detail: 'README 已写明「提交 → 推送 → 构建部署」三步顺序' };
}

/* ------------------------------ 汇总入口 ------------------------------ */

export async function runChecks({ skipDb = false } = {}) {
  const results = [
    checkGitClean(),
    checkPushed(),
    checkDistAssets(),
    checkDistFreshness(),
    await checkMigrations({ skipDb }),
    checkReadmeReleaseDoc(),
  ];
  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => r.ok && r.warn);
  return { ok: failed.length === 0, failed, warned, results };
}

/** CLI：不通过则 exit 1，供 CI / 发布前手工执行 */
async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const skipDb = argv.includes('--skip-db');
  const report = await runChecks({ skipDb });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('=== 发布前一致性检查（RQ-87）===');
    for (const r of report.results) {
      const mark = r.ok ? (r.warn ? '[WARN]' : '[ OK ]') : '[FAIL]';
      console.log(`${mark} ${r.name}: ${r.detail}`);
    }
    console.log(report.ok ? '\n结论：可以发布。' : `\n结论：阻断发布，${report.failed.length} 项未通过。`);
  }
  process.exit(report.ok ? 0 : 1);
}

// 仅在被直接执行时运行 CLI；被 import（单测）时不执行
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('检查脚本异常：', e);
    process.exit(2);
  });
}
