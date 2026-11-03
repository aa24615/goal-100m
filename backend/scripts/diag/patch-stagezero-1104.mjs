/**
 * 2026-11-04 外科式生产补丁：只修「0 份文档被判通过」这一处假绿。
 *
 * 为什么不是 docker cp 整个仓库文件：
 *   工作区有并行会话**未提交且未部署**的 RQ-176 在途改动（ISOLATION_SQL 函数化等），
 *   整体 cp 会把在途代码推上生产，且缺少配套的 northStar / trainingFunnel 改动会成半成品。
 *   因此只对容器内的旧版文件做 3 处精确字符串替换，幂等、可重放、不引入任何其他差异。
 *
 * 用法（在宿主机执行）：
 *   docker exec -i mm8888-backend-1 node --input-type=module < backend/scripts/diag/patch-stagezero-1104.mjs
 *   然后 docker restart mm8888-backend-1
 * 预期输出：PATCH_OK changed=3 或 PATCH_ALREADY_APPLIED
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = '/app/src/services/stageZeroService.js';

const PATCHES = [
  {
    name: 'docs-note',
    from: [
      '    note: bad.length === 0',
      '      ? `${files.length} 份文档均已包含对外地址。`',
      '      : `${bad.length}/${files.length} 份文档仍以本机地址作为唯一入口：${bad.map((f) => f.name).join(\'、\')}。`,',
    ].join('\n'),
    to: [
      '    note:',
      '      files.length === 0',
      '        ? \'未提供待审计文档（0 份）：无法判定对外化，调用方应视为无证据。\'',
      '        : bad.length === 0',
      '          ? `${files.length} 份文档均已包含对外地址。`',
      '          : `${bad.length}/${files.length} 份文档仍以本机地址作为唯一入口：${bad.map((f) => f.name).join(\'、\')}。`,',
    ].join('\n'),
  },
  {
    name: 'rq175-verdict',
    from: "    { rq: 'RQ-175', title: '文档对外化', verdict: docs.ok === true, detail: docs.note },",
    to: [
      '    {',
      "      rq: 'RQ-175',",
      "      title: '文档对外化',",
      '      // 0 份文档 = 无证据，不是「审过且全部合格」；生产镜像不含 README.md / nginx.conf。',
      '      verdict: docs.total === 0 ? null : docs.ok === true,',
      '      detail:',
      '        docs.total === 0',
      "          ? '未提供待审计文档（0 份）：生产镜像内无 README.md / frontend/nginx.conf，无法判定对外化，不计为通过。'",
      '          : docs.note,',
      '    },',
    ].join('\n'),
  },
  {
    name: 'summary-note',
    from: [
      '    note:',
      '      failed.length === 0',
      "        ? '阶段零五项 P0 全部通过。'",
      '        : `阶段零未通过 ${failed.length} 项：${failed.join(\'、\')}。`,',
    ].join('\n'),
    to: [
      '    note:',
      '      failed.length > 0',
      '        ? `阶段零未通过 ${failed.length} 项：${failed.join(\'、\')}。`',
      '        : unknown.length > 0',
      '          ? `阶段零无确凿失败，但 ${unknown.length} 项缺少证据：${unknown.join(\'、\')}；待补证后方可收口。`',
      "          : '阶段零五项 P0 全部通过。',",
    ].join('\n'),
  },
];

let text = readFileSync(TARGET, 'utf8');
const done = [];
for (const p of PATCHES) {
  if (text.includes(p.from)) {
    text = text.replace(p.from, p.to);
    done.push(p.name);
  }
}

// 幂等：已打过补丁时不再写盘，避免重复执行把文件改坏
if (done.length === 0) {
  const applied = text.includes("verdict: docs.total === 0 ? null : docs.ok === true");
  console.log(applied ? 'PATCH_ALREADY_APPLIED' : `PATCH_FAILED missing anchors; matched=${done.length}`);
} else if (done.length !== PATCHES.length) {
  console.log(`PATCH_FAILED partial matched=${done.join(',')} — 未写盘，请人工核对`);
} else {
  writeFileSync(TARGET, text, 'utf8');
  console.log(`PATCH_OK changed=${done.length} (${done.join(',')})`);
}
