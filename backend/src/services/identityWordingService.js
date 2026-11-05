/**
 * RQ-193 身份口径纠偏（P1）：对外「真实行情 + 模拟撮合」叙事一致性守护。
 *
 * v16 的硬要求：README / 免责声明 / 首屏三处口径必须一致，
 * 不得出现「虚拟仿真」「交易大厅」类误述——前者与实际跑真实行情矛盾，
 * 后者让产品正面撞同花顺/叩富，差异化叙事混乱（F-114）。
 *
 * 纯函数 + 文件扫描（fs 注入），便于无环境单测与发布前自证。
 * 禁止词与前端 `constants.ts` 的 FORBIDDEN_WORDINGS 对齐，避免前后端漂移。
 */

import { readFileSync, existsSync } from 'node:fs';

/** 禁止出现在对外口径中的措辞（与前端 FORBIDDEN_WORDINGS 对齐） */
export const FORBIDDEN_WORDINGS = [
  '虚拟仿真',
  '模拟交易大厅',
  'A 股模拟交易大厅',
  '交易大厅',
];

/** 对外口径必须包含的事实锚点：行情真实、资金/成交为模拟撮合 */
export const REQUIRED_PHRASES = ['真实 A 股行情', '模拟撮合'];

/**
 * 检查一段文本的身份口径是否合规（纯函数）。
 *
 * @param {string} text
 * @returns {{ok:boolean, forbiddenHits:string[], missingRequired:string[], text:string}}
 */
export function checkIdentityWording(text) {
  const t = String(text ?? '');
  const forbiddenHits = FORBIDDEN_WORDINGS.filter((w) => t.includes(w));
  const missingRequired = REQUIRED_PHRASES.filter((w) => !t.includes(w));
  return {
    ok: forbiddenHits.length === 0 && missingRequired.length === 0,
    forbiddenHits,
    missingRequired,
    text: t,
  };
}

/**
 * 扫描多个文件，返回任何违反口径的文件与命中的误述。
 *
 * @param {object} o
 * @param {string[]} o.paths       待扫描文件路径
 * @param {Function} [o.readFn]    readFileSync 注入（默认 node:fs）
 * @param {Function} [o.existsFn]  existsSync 注入
 */
export function scanRepoWording({ paths = [], readFn = readFileSync, existsFn = existsSync } = {}) {
  const offenders = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!existsFn(p)) {
      offenders.push({ path: p, status: 'missing', hits: [], missing: [] });
      continue;
    }
    let text = '';
    try {
      text = String(readFn(p, 'utf8'));
    } catch {
      offenders.push({ path: p, status: 'unreadable', hits: [], missing: [] });
      continue;
    }
    const r = checkIdentityWording(text);
    offenders.push({
      path: p,
      status: r.ok ? 'ok' : 'violation',
      hits: r.forbiddenHits,
      missing: r.missingRequired,
    });
  }
  const violations = offenders.filter((o) => o.status === 'violation');
  return { offenders, violations, ok: violations.length === 0 };
}
