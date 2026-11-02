/**
 * 公网入口收口（RQ-156）与责任人闭环（RQ-160 / RQ-172）
 *
 * v13 §0 的原话：**「屋里所有设备都通电了，电表转得飞快，但读数全是我们自己按出来的开关。」**
 * 公网入口连续**四版**没有装上，而每一版需求文档都写着「已完成」——因为大家读的是
 * 上一版文档的结论，没有人去核对 `.env` / nginx / README 这三个文件到底改没改。
 *
 * v12 已经把这层管住了（`publicAccessService.auditPublicEntrypoint` 直接解析文件出 blocker，
 * RQ-142 因此被如实判为未完成）。**但「能诊断」不等于「能修」**：
 * 诊断出 5 项 blocker 之后，运维要自己拼 4 条命令、改 3 个文件、背下 certbot 的路径，
 * 任何一步拼错就等于没做。这就是缺陷 F-99 的本质——**卡点是执行成本，不是工具缺失**。
 *
 * 因此本模块做三件事，把「最后一公里」从文档变成一条命令：
 *
 *   1. **`buildProvisionPlan`**：按域名产出**有序、幂等、可复制**的落地计划，
 *      每一步都给出「改哪个文件、改成什么、为什么」。默认 dry-run（只看不动）。
 *   2. **`upsertEnvVar`**：幂等改写 `.env`，保留注释与顺序。
 *      手写 `.env` 最常见的失败是「顺手重写一遍把别的键弄丢了」，必须机器来做。
 *   3. **`ownerState` / `frozenGate`**：把 RQ-160 的「指定 owner 与截止日」和
 *      RQ-172 的「RQ-156 未完成前不许解冻」变成可断言状态，不再靠人记。
 *
 * 设计约束：本模块**全是纯函数**——不读文件、不写文件、不发请求。
 * 真正的写入动作在 `scripts/provisionPublicEntry.js`，两者分离便于无环境单测。
 */

import { auditPublicEntrypoint, normalizeBaseUrl, hostOf, isLocalHost, renderNginxServerConf } from './publicAccessService.js';
// v15：剩余天数统一走 stageZeroService 的自然日口径。
// 此前 ownerState 用「截止日 23:59:59 时戳差取整」，同一天早晚算出的值会差 1 天，
// 与文档里写死的数字永远对不上；两处各算一套正是 F-102（口径与事实不符）的同类问题。
import { countdownOf } from './stageZeroService.js';

/** RQ-160：责任人公钥——没有 owner 的需求等于没有排期 */
export const OWNER_ENV_KEYS = {
  owner: 'PUBLIC_ENTRY_OWNER',
  deadline: 'PUBLIC_ENTRY_DEADLINE',
};

/** 截止日临近提醒窗口（天）：不是告警粒度，是「还没到但可以催了」 */
export const DEADLINE_WARN_DAYS = 3;

/** RQ-172 冻结范围：RQ-156 未完成前一律不进排期 */
export const FROZEN_RQS = ['RQ-161', 'RQ-162', 'RQ-163', 'RQ-164', 'RQ-165', 'RQ-166', 'RQ-167', 'RQ-168', 'RQ-169', 'RQ-170'];

function trim(v) {
  return String(v ?? '').trim();
}

/* ------------------------------------------------------------------ *
 * 一、.env 幂等改写                                                    *
 * ------------------------------------------------------------------ */

/**
 * 写入（或替换）一个环境变量，**保留注释、空行与其余键的顺序**。
 *
 * 为什么不能直接 `Object.entries` 重写一遍：`.env` 里大量的中文注释与分组标题
 * 是给人看的，机器重写会把它们全部吞掉，下一次运维打开文件时已经不知道该改哪里。
 *
 * @param {string} envText 原始 .env 文本
 * @param {string} key     变量名
 * @param {string} value   变量值
 * @param {object} [opts]  { comment: 写在键上方的注释（仅新增时追加） }
 * @returns {string} 新文本
 */
export function upsertEnvVar(envText, key, value, opts = {}) {
  const text = String(envText ?? '');
  const k = trim(key);
  const v = String(value ?? '');
  if (!k) return text;

  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  let replaced = false;
  let sawKey = false;

  const out = lines.map((line) => {
    if (re.test(line)) {
      if (sawKey) return null; // 重复定义：只保留第一次出现的那行，其余删除
      sawKey = true;
      replaced = true;
      return `${k}=${v}`;
    }
    return line;
  });

  let res = out.filter((l) => l !== null).join('\n');

  if (!replaced) {
    const comment = trim(opts.comment);
    // 新增：补一个空行 + 可选注释，保证不和上一行粘在一起
    if (res && !res.endsWith('\n')) res += '\n';
    res += `${res && !res.endsWith('\n\n') ? '\n' : ''}${comment ? `# ${comment}\n` : ''}${k}=${v}\n`;
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 二、RQ-160 责任人状态                                                *
 * ------------------------------------------------------------------ */

function toDate(v) {
  const s = trim(v);
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59+08:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 责任人状态（纯函数）。
 *
 * 五个状态刻意分细：`none`（连 owner 都没有，需求不存在）
 * 与 `overdue`（有 owner 但到期没做完）是两种失败，补救动作完全不同——
 * 前者是排期缺陷（RK-01），后者是执行缺陷。混为一个警告会让下一版继续原地。
 *
 * @param {object} o { owner, deadline, now }
 */
export function ownerState(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const owner = trim(src.owner) || null;
  const deadlineRaw = trim(src.deadline) || null;
  const deadline = deadlineRaw ? toDate(deadlineRaw) : null;
  const now = src.now instanceof Date ? src.now : new Date();

  let daysLeft = null;
  let state = 'none';
  if (owner && deadline) {
    daysLeft = countdownOf({ deadline: deadlineRaw, now }).daysLeft;
    state = daysLeft < 0 ? 'overdue' : daysLeft <= DEADLINE_WARN_DAYS ? 'due-soon' : 'ok';
  } else if (owner) {
    state = 'no-deadline';
  } else if (deadline) {
    state = 'no-owner';
  }

  const TEXT = {
    none: '未指定 owner 与截止日：连续四版未完成的根因是没有责任人，不是技术不可行。',
    'no-owner': '指定了截止日但没有 owner：日期到了也没人认领，等同于没有排期。',
    'no-deadline': '指定了 owner 但没有截止日：没有日期的承诺无法追责，也不会被提醒。',
    overdue: `已逾期 ${-daysLeft} 天：按 RQ-160 应当升级，而不是继续滚到下一版。`,
    'due-soon': `距截止日还有 ${daysLeft} 天，现在就该确认卡在哪一项。`,
    ok: `owner 与截止日均已指定，剩余 ${daysLeft} 天。`,
  };

  return {
    owner,
    deadline: deadline ? deadline.toISOString().slice(0, 10) : deadlineRaw,
    daysLeft,
    state,
    blocked: state === 'none' || state === 'no-owner' || state === 'overdue',
    note: TEXT[state],
  };
}

/* ------------------------------------------------------------------ *
 * 三、RQ-172 冻结护栏                                                  *
 * ------------------------------------------------------------------ */

/**
 * 冻结护栏（RQ-172）。
 *
 * 为什么要写成代码而不是写在文档里：文档里的「本条不再软化」过去三版都写了一次，
 * 每一版都被新提出的玩法需求冲掉。写成函数后，任何试图把冻结需求排进本期的工作
 * 都会拿到一个非空的 `blocked` 列表，并且理由可读。
 *
 * @param {object} o { publicReady:boolean, requested?:string[], owner?:object }
 */
export function frozenGate(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const ready = src.publicReady === true;
  const requested = Array.isArray(src.requested) && src.requested.length ? src.requested : FROZEN_RQS;
  const own = src.owner && typeof src.owner === 'object' ? src.owner : ownerState(src.ownerInput || {});

  const blocked = ready ? [] : requested.filter((r) => FROZEN_RQS.includes(String(r).trim().toUpperCase().replace(/\s/g, '')));
  const normalized = blocked.map((r) => String(r).trim().toUpperCase().replace(/\s/g, ''));

  return {
    publicReady: ready,
    frozen: FROZEN_RQS,
    requested: requested.map((r) => String(r).trim()),
    allowed: requested.filter((r) => !normalized.includes(String(r).trim().toUpperCase().replace(/\s/g, ''))),
    blocked: normalized,
    owner: own,
    ok: normalized.length === 0,
    note: ready
      ? '公网入口已就绪，冻结项可以按需解冻。'
      : `公网入口未就绪，${normalized.length} 项仍处冻结；在此之前需求池不得扩张（RQ-172）。`,
  };
}

/* ------------------------------------------------------------------ *
 * 四、README 入口章节                                                  *
 * ------------------------------------------------------------------ */

/**
 * 渲染 README 的「入口与责任人」章节。
 * 关键设计：**owner 与截止日必须和入口写在同一处**——分开写两个章节的结果是
 * 每次更新入口时都没人记得同步 owner，而 owner 恰好是最容易过期的那一项。
 */
export function renderReadmeEntry(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const url = trim(src.url);
  const own = src.owner && typeof src.owner === 'object' ? src.owner : ownerState({ owner: src.ownerName, deadline: src.deadline, now: src.now });
  const lines = [
    '## 公网入口',
    '',
    url
      ? `- **对外唯一入口**：${url}（所有分享链接基于此地址）`
      : '- **对外唯一入口**：*未配置*。当前只能在部署机本机用 `http://localhost:8080` 访问。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 责任人（RQ-160） | ${own.owner ? `\`${own.owner}\`` : '**未指定**' } |`,
    `| 截止日（RQ-160） | ${own.deadline ? `\`${own.deadline}\`` : '**未指定**' } |`,
    `| 状态 | ${own.state} —— ${own.note} |`,
    '',
    '上线后 10 分钟内必须执行 `DATABASE_URL=... node src/scripts/verifyRelease.js`，',
    '并把结果贴到本次发布的提交说明里；连续两次发布无验证记录即视为流程失效（RQ-160）。',
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 五、RQ-156 落地计划                                                  *
 * ------------------------------------------------------------------ */

/**
 * 生成 CDN/证书前的域名合法性校验（纯函数）。
 * 不接受内网/本机域名：把 `localhost` 配成 PUBLIC_BASE_URL 是最常见的自欺。
 */
export function validateDomain(raw) {
  const s = trim(raw);
  if (!s) return { ok: false, reason: '域名为空' };
  const host = hostOf(s);
  if (!host) return { ok: false, reason: `无法解析域名：${s}` };
  if (isLocalHost(host)) return { ok: false, reason: `${host} 是本机/内网地址，外部设备无法访问` };
  if (!/\.[a-z]{2,}$/i.test(host) && !/^[\d-]+\.nip\.io$/i.test(host)) {
    return { ok: false, reason: `${host} 不像一个可解析的公网域名` };
  }
  return { ok: true, host, reason: '' };
}

/**
 * 构建公网入口落地计划。
 *
 * 刻意**不直接改任何文件**：本函数只产出计划，执行在 `scripts/provisionPublicEntry.js`。
 * 诊断与执行分离有两个理由：单测不需要文件系统；运维可以先 review 再落地。
 *
 * @param {object} o
 * @param {string} [o.domain]      域名（自有域名或 nip.io 过渡域名）
 * @param {string} [o.email]       证书联系人邮箱（Let's Encrypt 到期提醒用）
 * @param {string} [o.upstream]    前端 upstream，默认 frontend:80
 * @param {boolean}[o.localhostUpstream] 测试用：upstream 指向本机
 * @returns {{ok:boolean, domain:string|null, steps:Array, blockers:string[], note:string}}
 */
export function buildProvisionPlan(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const v = validateDomain(src.domain);
  if (!v.ok) {
    return {
      ok: false,
      domain: null,
      publicUrl: null,
      steps: [],
      blockers: [v.reason],
      note: '域名不可用，无法生成落地计划。',
    };
  }

  const host = v.host;
  const publicUrl = normalizeBaseUrl(host);
  const email = trim(src.email);
  const upstream = trim(src.upstream) || 'frontend:80';
  const steps = [];

  steps.push({
    id: 'env',
    file: '.env',
    title: '写入 PUBLIC_BASE_URL',
    why: '没有这一步，分享链接与回调地址全部落在 localhost 上（F-95）。',
    patch: upsertEnvVar('# 原有配置保持不变\nJWT_SECRET=keep-me\n', 'PUBLIC_BASE_URL', publicUrl, {
      comment: 'RQ-156 公网入口：对外唯一地址',
    }),
    done: false,
  });

  if (trim(src.ownerName)) {
    steps.push({
      id: 'owner',
      file: '.env',
      title: '写入 PUBLIC_ENTRY_OWNER / PUBLIC_ENTRY_DEADLINE',
      why: 'RQ-160：连续四版未完成的根因是「工具已给、没人认领」。写进 .env 后 owner 可被 assert。',
      patch: upsertEnvVar(
        upsertEnvVar('JWT_SECRET=keep-me\n', 'PUBLIC_ENTRY_OWNER', trim(src.ownerName)),
        'PUBLIC_ENTRY_DEADLINE',
        trim(src.deadline || '')
      ),
      done: false,
    });
  }

  steps.push({
    id: 'nginx',
    file: 'frontend/nginx.conf',
    title: '替换为带 HTTPS 与 301 跳转的站点配置',
    why: 'HTTP 明文可达 + server_name _ 是离线 third-party 证书签发失败的直接原因（F-87）。',
    patch: renderNginxServerConf({ host, upstream }),
    done: false,
  });

  steps.push({
    id: 'cert',
    title: '签发 HTTPS 证书',
    why: '公网入口必须 HTTPS，否则手机浏览器拦截且分享链接不可信。',
    command: email
      ? `certbot certonly --standalone -d ${host} -m ${email} --agree-tos -n`
      : `certbot certonly --standalone -d ${host} --register-unsafely-without-email --agree-tos -n`,
    done: false,
  });

  steps.push({
    id: 'reload',
    title: '重建并重载 nginx',
    why: 'nginx 在容器启动时就把配置读进内存，改了文件不 reload 等于没改。',
    command: 'docker-compose up -d --build frontend && docker-compose exec frontend nginx -s reload',
    done: false,
  });

  steps.push({
    id: 'verify',
    title: '发布后验证',
    why: 'RQ-160 要求 10 分钟内跑完验证；不验证的发布等于没发布（v7/v10 两次教训）。',
    command: `DATABASE_URL=... node src/scripts/verifyRelease.js --base=${publicUrl}`,
    done: false,
  });

  return {
    ok: true,
    domain: host,
    publicUrl,
    steps,
    blockers: [],
    note: `${steps.length} 步；默认只输出不落盘，加 --apply 才真正写文件。`,
  };
}

/**
 * 汇总态：把「文件审计 + 责任人状态 + 冻结护栏」合成一个可断言对象，
 * 供 `/api/public/access` 与 `releaseCheck` 共用，避免两处口径分叉。
 */
export function summarizePublicEntry({ envText, nginxText, readmeText, smoke, now = new Date() } = {}) {
  const audit = auditPublicEntrypoint({ envText, nginxText, readmeText, smoke });
  const env = Object.fromEntries(
    String(envText ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
  const own = ownerState({ owner: env.PUBLIC_ENTRY_OWNER, deadline: env.PUBLIC_ENTRY_DEADLINE, now });
  const gate = frozenGate({ publicReady: audit.ready, owner: own });
  return { audit, owner: own, gate, ready: audit.ready && !own.blocked, nextAction: audit.nextAction };
}

export default {
  upsertEnvVar,
  ownerState,
  frozenGate,
  renderReadmeEntry,
  validateDomain,
  buildProvisionPlan,
  summarizePublicEntry,
  FROZEN_RQS,
  OWNER_ENV_KEYS,
  DEADLINE_WARN_DAYS,
};
