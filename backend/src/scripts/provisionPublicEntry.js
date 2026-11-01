#!/usr/bin/env node
/**
 * RQ-156 公网入口落地脚本（dry-run 默认，--apply 才写盘）
 *
 * 存在的理由：v13 §4 F-99 说得很直白——**配置工具已给齐（`/public/access/nginx`、
 * `/env` 可直出片段），连续四版无人执行。说明卡点不是工具而是责任归属。**
 * 责任归属问题有一部分真的是「执行成本」：运维要自己拼 4 条命令、改 3 个文件、
 * 背下 certbot 路径。任何一步拼错就等于没做，而没人愿意为一个「可能拼错」的动作负责。
 *
 * 本脚本把这件事收敛成一条命令，并且：
 *   - **默认 dry-run**：先看会得到什么，不写任何文件；
 *   - **幂等**：重复执行不会产生第二份 `PUBLIC_BASE_URL`（`upsertEnvVar` 保证）；
 *   - **不删除既有内容**：`.env` 只 upsert 键，注释与其余键原样保留；
 *   - **不自动签证书**：证书涉及外部服务与生产流量切换，脚本只打印命令并校验前置。
 *
 * 用法：
 *   node src/scripts/provisionPublicEntry.js --domain=train.example.com --email=me@example.com
 *   node src/scripts/provisionPublicEntry.js --domain=1.2.3.4.nip.io --owner=张三 --deadline=2026-11-08 --apply
 *   node src/scripts/provisionPublicEntry.js --domain=... --json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProvisionPlan,
  upsertEnvVar,
  ownerState,
  renderReadmeEntry,
  validateDomain,
  summarizePublicEntry,
} from '../services/publicEntryService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const ENV_FILE = join(REPO_ROOT, '.env');
export const NGINX_FILE = join(REPO_ROOT, 'frontend', 'nginx.conf');
export const README_FILE = join(REPO_ROOT, 'README.md');

export function parseArgs(argv = []) {
  const o = { apply: false, json: false };
  for (const a of argv) {
    if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--domain=')) o.domain = a.slice(9);
    else if (a.startsWith('--email=')) o.email = a.slice(8);
    else if (a.startsWith('--owner=')) o.owner = a.slice(8);
    else if (a.startsWith('--deadline=')) o.deadline = a.slice(11);
    else if (a.startsWith('--upstream=')) o.upstream = a.slice(11);
  }
  return o;
}

function readMaybe(file, readFn = readFileSync, existsFn = existsSync) {
  try {
    return existsFn(file) ? readFn(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * 执行落地（可注入文件依赖，便于单测）。
 * @returns {{ok:boolean, written:string[], skipped:string[], plan:object, note:string}}
 */
export function runProvision(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const readFn = o.readFn || readFileSync;
  const writeFn = o.writeFn || writeFileSync;
  const existsFn = o.existsFn || existsSync;

  const v = validateDomain(o.domain);

  /**
   * 只认领责任人（RQ-160）而不配域名（RQ-156）的场景。
   *
   * 这不是退化，而是**把两件事解耦**：域名要买、要解析、要签证书，可能卡一周；
   * 而「指定 owner 与截止日」是一分钟就能做完的事。
   * v13 的教训正是「两件事绑在一起，结果一件都没做」——
   * 连续四版既没域名也没 owner。允许分开认领，至少让责任和截止日先落地。
   */
  if (!v.ok && (o.owner || o.deadline)) {
    return provisionOwnerOnly({ ...o, readFn, writeFn, existsFn, reason: v.reason });
  }
  if (!v.ok) return { ok: false, written: [], skipped: [], blockers: [v.reason], note: '域名不可用。', plan: null };

  const plan = buildProvisionPlan({
    domain: o.domain,
    email: o.email,
    upstream: o.upstream,
    ownerName: o.owner,
    deadline: o.deadline,
  });

  const written = [];
  const skipped = [];

  // ① .env：PUBLIC_BASE_URL + owner/deadline
  const envPath = o.envFile || ENV_FILE;
  const envText = readMaybe(envPath, readFn, existsFn);
  let nextEnv = upsertEnvVar(envText, 'PUBLIC_BASE_URL', plan.publicUrl, { comment: 'RQ-156 公网入口：对外唯一地址' });
  if (o.owner) nextEnv = upsertEnvVar(nextEnv, 'PUBLIC_ENTRY_OWNER', o.owner);
  if (o.deadline) nextEnv = upsertEnvVar(nextEnv, 'PUBLIC_ENTRY_DEADLINE', o.deadline);

  if (nextEnv !== envText) {
    if (o.apply) writeFn(envPath, nextEnv, 'utf8');
    written.push(`${o.apply ? '已写入' : '将写入'} ${envPath}`);
  } else {
    skipped.push(`${envPath} 无需变更（PUBLIC_BASE_URL 已是 ${plan.publicUrl}）`);
  }

  // ② nginx.conf：整份替换（旧配置没有 server_name / 443，无法增量改）
  const nginxPath = o.nginxFile || NGINX_FILE;
  const nginxText = readMaybe(nginxPath, readFn, existsFn);
  const nginxStep = plan.steps.find((s) => s.id === 'nginx');
  const nextNginx = nginxStep?.patch || '';
  if (nextNginx && nextNginx.trim() !== nginxText.trim()) {
    if (o.apply) writeFn(nginxPath, nextNginx, 'utf8');
    written.push(`${o.apply ? '已写入' : '将写入'} ${nginxPath}（server_name=${plan.domain}，HTTP 301 → HTTPS）`);
  } else {
    skipped.push(`${nginxPath} 无需变更（已是带 HTTPS 的配置）`);
  }

  // ③ README：入口章节（owner 与入口同处一章，防止只更新其中一个）
  const readmePath = o.readmeFile || README_FILE;
  const readmeText = readMaybe(readmePath, readFn, existsFn);
  const section = renderReadmeEntry({ url: plan.publicUrl, ownerName: o.owner, deadline: o.deadline });
  const marker = '## 公网入口';
  let nextReadme = readmeText;
  if (readmeText.includes(marker)) {
    const i = readmeText.indexOf(marker);
    const end = readmeText.indexOf('\n## ', i + 1);
    nextReadme = (end > 0 ? readmeText.slice(0, i) + section + readmeText.slice(end) : readmeText.slice(0, i) + section).replace(/\n{3,}/g, '\n\n');
  } else {
    nextReadme = `${readmeText.replace(/\s*$/, '')}\n\n${section}`;
  }
  if (nextReadme.trim() !== readmeText.trim()) {
    if (o.apply) writeFn(readmePath, nextReadme, 'utf8');
    written.push(`${o.apply ? '已写入' : '将写入'} ${readmePath}（入口与责任人章节）`);
  } else {
    skipped.push(`${readmePath} 无需变更`);
  }

  const own = ownerState({ owner: o.owner, deadline: o.deadline, now: o.now });
  const after = summarizePublicEntry({
    envText: nextEnv,
    nginxText: nextNginx,
    readmeText: nextReadme,
    now: o.now,
  });

  return {
    ok: true,
    apply: Boolean(o.apply),
    domain: plan.domain,
    publicUrl: plan.publicUrl,
    written,
    skipped,
    owner: own,
    plan,
    after,
    blockers: [],
    note: o.apply
      ? `已落地 ${written.length} 处；证书与重载需人工执行（涉及生产流量切换，脚本不代劳）。`
      : 'dry-run：未写入任何文件。确认无误后加 --apply。',
    manualSteps: plan.steps.filter((s) => s.command),
  };
}

/**
 * 仅写「责任人 + 截止日」的落地（RQ-160）。
 *
 * 与域名落地共用同一套 `upsertEnvVar` / `renderReadmeEntry`，
 * 保证「入口与责任人写在同一处」这条约定不会被两条路径写歪。
 */
export function provisionOwnerOnly(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const readFn = o.readFn || readFileSync;
  const writeFn = o.writeFn || writeFileSync;
  const existsFn = o.existsFn || existsSync;

  const envPath = o.envFile || ENV_FILE;
  const readmePath = o.readmeFile || README_FILE;
  const envText = readMaybe(envPath, readFn, existsFn);
  const readmeText = readMaybe(readmePath, readFn, existsFn);

  let nextEnv = envText;
  if (o.owner) nextEnv = upsertEnvVar(nextEnv, 'PUBLIC_ENTRY_OWNER', o.owner, { comment: 'RQ-160 公网入口责任人' });
  if (o.deadline) nextEnv = upsertEnvVar(nextEnv, 'PUBLIC_ENTRY_DEADLINE', o.deadline);

  const env = Object.fromEntries(
    nextEnv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
  const url = String(env.PUBLIC_BASE_URL || env.DOMAIN || '').trim() || null;

  const section = renderReadmeEntry({ url, ownerName: o.owner, deadline: o.deadline, now: o.now });
  const marker = '## 公网入口';
  let nextReadme = readmeText;
  if (readmeText.includes(marker)) {
    const i = readmeText.indexOf(marker);
    const end = readmeText.indexOf('\n## ', i + 1);
    nextReadme = (end > 0 ? readmeText.slice(0, i) + section + readmeText.slice(end) : readmeText.slice(0, i) + section).replace(/\n{3,}/g, '\n\n');
  } else {
    nextReadme = `${readmeText.replace(/\s*$/, '')}\n\n${section}`;
  }

  const written = [];
  const skipped = [];
  if (nextEnv !== envText) {
    if (o.apply) writeFn(envPath, nextEnv, 'utf8');
    written.push(`${o.apply ? '已写入' : '将写入'} ${envPath}（PUBLIC_ENTRY_OWNER / PUBLIC_ENTRY_DEADLINE）`);
  } else {
    skipped.push(`${envPath} 无需变更`);
  }
  if (nextReadme.trim() !== readmeText.trim()) {
    if (o.apply) writeFn(readmePath, nextReadme, 'utf8');
    written.push(`${o.apply ? '已写入' : '将写入'} ${readmePath}（入口与责任人章节）`);
  } else {
    skipped.push(`${readmePath} 无需变更`);
  }

  const own = ownerState({ owner: o.owner, deadline: o.deadline, now: o.now });
  return {
    ok: true,
    mode: 'owner-only',
    apply: Boolean(o.apply),
    publicUrl: url,
    written,
    skipped,
    owner: own,
    plan: null,
    blockers: url ? [] : ['公网地址仍未配置（PUBLIC_BASE_URL 缺失）：责任人已认领，但 RQ-156 本体仍未完成'],
    note: o.apply
      ? `已落地 ${written.length} 处；域名与证书仍需单独执行（--domain=... --apply）。`
      : 'dry-run（仅责任人）：未写入任何文件。确认无误后加 --apply。',
    domainSkipped: o.reason || '未提供域名',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const r = runProvision(args);
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('=== RQ-156 公网入口落地（' + (args.apply ? 'apply' : 'dry-run') + '）===');
    if (!r.ok) {
      console.log(`[FAIL] ${(r.blockers || []).join('；')}`);
      process.exit(1);
    }
    console.log(r.mode === 'owner-only' ? '模式：仅认领责任人（RQ-160），不触碰域名与证书' : `域名：${r.domain}  对外地址：${r.publicUrl}`);
    for (const w of r.written) console.log(`  · ${w}`);
    for (const s of r.skipped) console.log(`  · ${s}`);
    console.log(`责任人：${r.owner.state} —— ${r.owner.note}`);
    const manual = r.manualSteps || [];
    if (manual.length) {
      console.log('\n需人工执行：');
      for (const s of manual) console.log(`  $ ${s.command}`);
    }
    for (const b of r.blockers || []) console.log(`  [BLOCKER] ${b}`);
    console.log(`\n${r.note}`);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export default { runProvision, provisionOwnerOnly, parseArgs, REPO_ROOT, ENV_FILE, NGINX_FILE, README_FILE };
