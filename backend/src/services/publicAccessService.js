/**
 * 公网可达性（RQ-106 / F-30）
 *
 * v9 的头号结论：**产品目前没有公网入口**。唯一访问地址是 `http://localhost:8080`，
 * nginx `server_name _`、只监听 80，仓库里没有任何域名 / HTTPS / 端口转发证据。
 * 在这个前提下，「获客」「留存」「首训转化」三项工作在物理上都不可执行——
 * RQ-105 的归因管道做得再完整，也读不到一个新用户。
 *
 * 工程侧能做的是把「是否有公网入口」从口头确认变成**可断言的状态**：
 *   - 从环境变量解析出唯一的对外地址（PUBLIC_BASE_URL 优先，其次 DOMAIN）；
 *   - 给出缺什么补什么的清单，缺项即为 blocker；
 *   - 把 localhost / 127.0.0.1 / 内网段判定为「不可对外」，防止自欺。
 *
 * 本模块是纯函数：不读数据库、不发请求，便于无环境单测。
 */

/** 不可对外的宿主：本机与常见内网段 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export const PUBLIC_ACCESS_ENV_KEYS = ['PUBLIC_BASE_URL', 'DOMAIN', 'PUBLIC_HOST', 'PUBLIC_PORT'];

function trim(v) {
  return String(v ?? '').trim();
}

/** 去掉协议、路径、端口，只留 host（用于内网段判定） */
export function hostOf(url) {
  const s = trim(url);
  if (!s) return '';
  // 允许带协议或不带协议两种写法
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isLocalHost(host) {
  const h = trim(host).toLowerCase();
  if (!h) return true;
  if (LOCAL_HOSTS.has(h)) return true;
  // 内网段：10/8、172.16/12、192.168/16、169.254/16（链路本地）
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 规范化对外地址：补 https 前缀、去掉结尾斜杠。
 * 未显式给协议时默认 https —— 公网入口默认走 HTTPS 是硬约束（RQ-106 验收）。
 */
export function normalizeBaseUrl(raw) {
  const s = trim(raw);
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    // 去掉默认端口造成的噪音（https 443 / http 80）
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 公网 IPv4 判定：非本机、非内网段，且是合法 IPv4 字面量 */
export function isPublicIpv4(ip) {
  const s = trim(ip);
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) return false;
  const parts = s.split('.').map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return false;
  if (isLocalHost(s)) return false;
  // 保留/特殊用途段：不能被当作公网出口
  if (parts[0] === 0 || parts[0] === 127 || parts[0] >= 224) return false;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false; // CGNAT 100.64/10
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return false; // TEST-NET-1
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return false; // TEST-NET-2
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return false; // TEST-NET-3
  if (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) return false; // 6to4 中继任播
  return true;
}

/**
 * 没有自有域名时的可执行替代：免费泛解析域名（nip.io 一类）把 IP 直接编进域名，
 * 免去「先买域名再等解析」这一步。这不是最终形态，但能把 RQ-122 从
 * 「等决策」变成「今天就能做」——冷启动阶段最贵的是等待。
 */
export function suggestEphemeralDomain(ip) {
  const s = trim(ip);
  if (!isPublicIpv4(s)) return null;
  return `${s.replace(/\./g, '-')}.nip.io`;
}

/** 生成 .env 片段：给出可直接粘贴的公网地址配置行 */
export function renderEnvSnippet(o) {
  const src = o && typeof o === 'object' ? o : {};
  const host = trim(src.host);
  if (!host) return '';
  const url = normalizeBaseUrl(host);
  return [`# RQ-122 公网入口：唯一对外地址，分享链接与回调都基于它`, `PUBLIC_BASE_URL=${url}`].join('\n');
}

/**
 * 解析公网可达性。
 *
 * @param {object} [env] 默认 process.env
 * @param {object} [opts] 已完成项的外部证据：{readme, smoke} 为 true 时对应检查项标记完成。
 *   这两项无法从环境变量推导（README 是否改过、有没有人用手机打开过），
 *   只能由调用方（部署脚本 / 人工确认）显式声明。
 * @returns {{ready:boolean, publicUrl:string|null, host:string|null, https:boolean,
 *            source:string|null, blockers:string[], checklist:string[], note:string}}
 */
export function resolvePublicAccess(env = process.env, opts = {}) {
  const e = env && typeof env === 'object' ? env : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const raw = trim(e.PUBLIC_BASE_URL) || trim(e.DOMAIN) || trim(e.PUBLIC_HOST);
  const source = trim(e.PUBLIC_BASE_URL)
    ? 'PUBLIC_BASE_URL'
    : trim(e.DOMAIN)
      ? 'DOMAIN'
      : trim(e.PUBLIC_HOST)
        ? 'PUBLIC_HOST'
        : null;

  const publicUrl = normalizeBaseUrl(raw);
  const host = hostOf(publicUrl);
  const https = publicUrl ? publicUrl.startsWith('https://') : false;

  const blockers = [];
  if (!raw) {
    blockers.push('未配置对外地址：设置 PUBLIC_BASE_URL（或 DOMAIN）环境变量，例如 https://train.example.com');
  } else if (!publicUrl) {
    blockers.push(`对外地址无法解析：${raw}`);
  } else {
    if (isLocalHost(host)) blockers.push(`对外地址指向本机/内网（${host}），外部设备无法访问`);
    if (!https) blockers.push('未启用 HTTPS：公网入口必须走 HTTPS，否则手机浏览器会拦截且分享链接不可信');
  }

  const checklist = [
    { key: 'dns', label: '域名解析到部署机公网 IP', done: Boolean(host) && !isLocalHost(host) },
    { key: 'https', label: 'HTTPS 证书与反代配置生效', done: https },
    { key: 'proxy', label: 'nginx server_name 与实际域名一致（不再是 _）', done: Boolean(host) && !isLocalHost(host) },
    { key: 'readme', label: 'README 唯一入口改为公网地址（不再以 localhost 为入口）', done: o.readme === true },
    { key: 'smoke', label: '用手机 4G 网络打开链接并完成一次训练', done: o.smoke === true },
  ];

  return {
    ready: blockers.length === 0,
    publicUrl: publicUrl || null,
    host: host || null,
    https,
    source,
    blockers,
    checklist,
    // RQ-106 是 RQ-105（获客归因）的物理前置：没有入口，任何渠道参数都没有落点
    downstream: ['RQ-105 获客归因', 'RQ-114 渠道落地', '北极星首训完成率'],
    note:
      blockers.length === 0
        ? `对外地址已配置为 ${publicUrl}，公网可达性可对外声称。`
        : '当前不具备公网可达性；在完成前，获客与留存类指标在物理上不可执行。',
    // 下一步动作：把「不可达」从一句抱怨变成一条可执行指令
    nextAction: blockers.length === 0 ? '公网入口已就绪，进入首训闭环实测。' : blockers[0],
  };
}

/**
 * 生成 nginx 反代配置片段（RQ-106 的「反代与 server_name 配置落地」）。
 * 只产出文本，不写文件——部署动作留给运维，避免代码擅自改动生产配置。
 */
export function renderNginxServerConf({ host, upstream = 'frontend:80' } = {}) {
  const serverName = trim(host) || '_';
  return [
    `server {`,
    `  listen 80;`,
    `  server_name ${serverName};`,
    `  # RQ-106：所有 HTTP 一律跳转 HTTPS，公网入口不允许明文可达`,
    `  return 301 https://$host$request_uri;`,
    `}`,
    ``,
    `server {`,
    `  listen 443 ssl;`,
    `  http2 on;`,
    `  server_name ${serverName};`,
    ``,
    `  ssl_certificate     /etc/letsencrypt/live/${serverName}/fullchain.pem;`,
    `  ssl_certificate_key /etc/letsencrypt/live/${serverName}/privkey.pem;`,
    ``,
    `  location /api/ {`,
    `    proxy_pass http://backend:3000/;`,
    `    proxy_set_header Host $host;`,
    `    proxy_set_header X-Real-IP $remote_addr;`,
    `    proxy_set_header X-Forwarded-Proto $scheme;`,
    `  }`,
    ``,
    `  location / {`,
    `    proxy_pass http://${upstream};`,
    `    proxy_set_header Host $host;`,
    `    proxy_set_header X-Real-IP $remote_addr;`,
    `    proxy_set_header X-Forwarded-Proto $scheme;`,
    `  }`,
    `}`,
    ``,
  ].join('\n');
}
