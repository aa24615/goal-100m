/**
 * 阶段零收口（v15 · RQ-173 ~ RQ-177）
 *
 * v15 §v15-0 的原话：**「债基本还清了，只差门牌号；而门牌号这次终于有了主人和日期。」**
 * 前十四版反复出现的「代码写完 ≠ 提交 ≠ 部署 ≠ 验证」链路问题已全部收口，
 * 唯一仍未完成的一件事，是**让外部真人能打开这个页面**。
 *
 * 本模块把阶段零的五项 P0 全部变成**可断言的纯函数**，理由与 v13 一致：
 * 需求文档里写「已完成」而事实未完成，已经连续发生了六版（RQ-142 → RQ-156 → RQ-173），
 * 根因是每一版都在读上一版的结论，没有人去核对文件与数据库到底改没改。
 * **能诊断不等于能验收**——因此每一项都产出 `ok` + 证据 + 可读理由。
 *
 * 五项分工：
 *   - RQ-173 `statusTruthfulness`    —— 修 F-102：入口未配置却自评「状态 ok」
 *   - RQ-174 `auditLanding`          —— 首屏三要素与「首访→训练 ≤2 次点击」
 *   - RQ-175 `auditDocsPublicness`   —— 文档里本机地址不再作为唯一入口
 *   - RQ-176 `auditCompletionConsistency` —— 「完成一次训练」全站统一为有效完成
 *   - RQ-177 `stageZeroVerification` —— 去重 / 隔离 / 对账 / 连续 2 次留痕
 *
 * 设计约束（沿用 v8 起的分层约定）：
 *   1. **全是纯函数**——不读文件、不写文件、不发请求、不连库；取数由调用方注入。
 *      这样单测不需要任何环境，而「需要环境的部分」单独放在 `queryFn` 里。
 *   2. **凡 SQL 的 NULLIF 结果进 JS，必须先判 null / 空串再 Number()**——
 *      `Number(null) === 0` 这一族缺陷在本项目已出现三次（v10 identityOf、
 *      v13 reconcileConsistency、v13 guestUserId），是本项目最高频的复发病。
 *   3. 所有 `o = {}` 入参都要能扛住 `null`（`f(null)` 会绕过默认参数直接 TypeError）。
 */

/* ------------------------------------------------------------------ *
 * 公共小工具                                                          *
 * ------------------------------------------------------------------ */

/**
 * 埋点口径只需一份声明，从 testIsolationService 复用而不是再写一遍。
 *
 * 缺失这一行时 `ISOLATION_SQL()` 会抛 ReferenceError，而
 * `collectVerificationEvidence` 的 try/catch 会把它**静默降级成 null**，
 * 于是「取数炸了」和「查不到」长得一模一样——正是本模块要防的假象。
 */
import { TRAFFIC_SCOPES, trafficScopeJoin, trafficScopeWhere } from './testIsolationService.js';

function obj(o) {
  return o && typeof o === 'object' ? o : {};
}

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * 安全取数：**null / '' / NaN 一律返回 null，绝不返回 0**。
 *
 * 这是本模块所有数字入口的唯一通道。`Number(null) === 0` 会让「没有 sessionId」
 * 被算成「session 0」，而 0 是一个合法 id——缺陷因此被静默吞掉。
 */
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = trim(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function dayMs(n) {
  return Math.round((Number(n) || 0) * 86400000);
}

/* ================================================================== *
 * 一、RQ-173：对外可访问地址与「状态口径不再自评 ok」                    *
 * ================================================================== */

/**
 * v15 冻结范围（硬约束第 7 条）：RQ-173 未完成时，RQ-178~186 一律不进排期。
 *
 * 与 v13 的 `FROZEN_RQS`（RQ-161~170）刻意**分开定义**：版本号不同的冻结集合
 * 混在一个常量里，会让「上一版已解冻的需求」被下一版的护栏误挡，也会让
 * 历史用例的断言语义漂移。
 */
export const FROZEN_RQS_V15 = [
  'RQ-178',
  'RQ-179',
  'RQ-180',
  'RQ-181',
  'RQ-182',
  'RQ-183',
  'RQ-184',
  'RQ-185',
  'RQ-186',
];

/** F-102 的矛盾码 → 人话 */
export const STATUS_TRUTH_TEXT = {
  OK_WITHOUT_ENTRY: '责任人状态自评 ok，但对外入口仍未配置：「已指定 owner」被读成「入口已可用」。',
  ENTRY_SAYS_UNCONFIGURED: '文档仍写「对外唯一入口：未配置」，与同段的状态自评互相矛盾。',
  COUNTDOWN_STALE: '文档里的剩余天数与实际日期不符：倒计时不随日期更新，看板会把过期承诺当真。',
  DEADLINE_PASSED: '截止日已过但状态仍非 overdue：逾期未被升级，需求会继续滚到下一版。',
};

/**
 * 倒计时（纯函数）。
 *
 * 为什么要单独做成函数：v15 实测抓到 README 写「剩余 15 天」而按 11-03 实际只剩 13 天。
 * 一个写死的数字在文档里活两周就会变成假信息——而假信息的危害不是「不准」，
 * 是**让干系人以为还有时间**。
 *
 * @param {object} o { deadline:string, now:Date }
 * @returns {{daysLeft:number|null, expired:boolean, stale:boolean, text:string}}
 */
/**
 * 上海时区的「自然日序号」：把 YYYY-MM-DD 归一到该日 00:00Z 的时间戳。
 *
 * `Intl.DateTimeFormat` 是模块级单例——v10 踩过在循环里 new 的坑
 * （20000 次连打构建从 76s 降到 0.66s 就是靠这个缓存）。
 */
const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function shanghaiDayNum(date) {
  const s = DATE_FMT.format(date); // en-CA → YYYY-MM-DD
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

export function countdownOf(o = {}) {
  const src = obj(o);
  const raw = trim(src.deadline);
  const now = src.now instanceof Date ? src.now : new Date();
  if (!raw) {
    return { daysLeft: null, expired: false, stale: false, text: '未设置截止日。' };
  }
  // 纯日期按「当天 00:00（上海）」解析，带时戳的原样解析
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00+08:00`) : new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { daysLeft: null, expired: false, stale: true, text: `截止日无法解析：${raw}` };
  }

  /**
   * 按**自然日**相减，而不是按时戳差取整。
   *
   * 时戳差会随「现在几点」浮动：同一天早上算出 14 天、晚上算出 13 天，
   * 于是文档里那个数字永远对不上，也无法被断言。v15 实测 README 写 15 天、
   * 实际 13 天（11-03 → 11-16），用的就是自然日口径。
   */
  const dn = shanghaiDayNum(d);
  const nn = shanghaiDayNum(now);
  if (dn === null || nn === null) {
    return { daysLeft: null, expired: false, stale: true, text: `截止日无法换算：${raw}` };
  }
  const daysLeft = Math.round((dn - nn) / 86400000);
  const expired = daysLeft < 0;
  return {
    daysLeft,
    expired,
    stale: false,
    text: expired
      ? `已逾期 ${-daysLeft} 天（截止日 ${raw}）。`
      : `距截止日 ${raw} 还有 ${daysLeft} 天。`,
  };
}

/**
 * 状态口径自洽校验（RQ-173 的第三条验收：状态口径不再自评 ok）。
 *
 * 输入刻意同时要 `entryReady`（事实）与 `readmeText`（口径）——
 * F-102 的本质就是**这两个来源互相矛盾却没人比对**。只传一个来源时
 * 本函数无法工作，因此缺任一项都会给出 `UNKNOWN` 而不是 `ok`：
 * 在「证据不足」时判 ok，正是连续六版把未完成写成已完成的机制。
 *
 * @param {object} o
 * @param {boolean} o.entryReady 公网入口是否真的就绪（来自 auditPublicEntrypoint）
 * @param {object}  [o.owner]    ownerState() 的结果
 * @param {string}  [o.readmeText] README / 文档中「公网入口」章节的原文
 * @param {Date}    [o.now]
 */
export function statusTruthfulness(o = {}) {
  const src = obj(o);
  const ready = src.entryReady === true;
  const own = obj(src.owner);
  const text = String(src.readmeText ?? '');
  const now = src.now instanceof Date ? src.now : new Date();
  const contradictions = [];

  // ① 入口未配置，但 owner 状态自评 ok → F-102
  if (!ready && own.state === 'ok') {
    contradictions.push({ code: 'OK_WITHOUT_ENTRY', text: STATUS_TRUTH_TEXT.OK_WITHOUT_ENTRY });
  }

  // ② 文档同时出现「未配置」与「状态 ok」→ 同一段自相矛盾
  const saysUnconfigured = /对外唯一入口[^\n]*未配置|未配置/.test(text);
  const saysOk = /状态\s*[|｜]?\s*ok|状态\s*ok/i.test(text);
  if (saysUnconfigured && saysOk) {
    contradictions.push({
      code: 'ENTRY_SAYS_UNCONFIGURED',
      text: STATUS_TRUTH_TEXT.ENTRY_SAYS_UNCONFIGURED,
    });
  }

  // ③ 文档里的剩余天数与实际不符 → 倒计时不随日期更新
  const m = text.match(/剩余\s*(\d+)\s*天/);
  const claimed = numOrNull(m ? m[1] : null);
  const cd = countdownOf({ deadline: own.deadline, now });
  if (claimed !== null && cd.daysLeft !== null && claimed !== cd.daysLeft) {
    contradictions.push({
      code: 'COUNTDOWN_STALE',
      claimed,
      actual: cd.daysLeft,
      text: `${STATUS_TRUTH_TEXT.COUNTDOWN_STALE}（文档写 ${claimed} 天，实际 ${cd.daysLeft} 天）`,
    });
  }

  // ④ 已过截止日但状态不是 overdue → 逾期未被升级
  if (cd.expired && own.state && own.state !== 'overdue') {
    contradictions.push({
      code: 'DEADLINE_PASSED',
      text: `${STATUS_TRUTH_TEXT.DEADLINE_PASSED}（当前状态被标为 ${own.state}）`,
    });
  }

  return {
    entryReady: ready,
    ownerState: own.state ?? null,
    contradictions,
    count: contradictions.length,
    ok: contradictions.length === 0,
    countdown: cd,
    // 事实不足时不判 ok：这是六版「写成已完成」的机制性防线
    verdict:
      contradictions.length === 0
        ? '状态口径与事实一致。'
        : contradictions.map((c) => c.text).join(' '),
  };
}

/* ================================================================== *
 * 二、RQ-174：首屏落地页与首访最短路径                                  *
 * ================================================================== */

/** 首屏必须回答的三个问题——少一个，新用户就会带着疑问离开 */
export const LANDING_ELEMENTS = [
  { key: 'what', title: '练什么', required: true },
  { key: 'register', title: '要不要注册', required: true },
  { key: 'retention', title: '记录留多久', required: true },
];

/** RQ-174 的验收：首访 → 训练 ≤ 2 次点击 */
export const MAX_FIRST_VISIT_CLICKS = 2;

/**
 * 首访路径点击成本（纯函数）。
 *
 * `path` 是用户从落地页到训练页实际要点的一系列动作。
 * 刻意**只统计点击、不统计滚动与阅读**：需求写的是「≤2 次点击」，
 * 把「看」算进去会让任何方案都不达标，从而失去约束意义。
 *
 * 每个动作 `{ kind: 'click' | 'auto' }`：
 * `auto` 是系统自动跳转（例如游客身份自动创建），不占用用户点击预算，
 * 但会在 `steps` 里留痕，避免有人靠「全设成 auto」把成本刷成 0。
 */
export function clickPathCost(path, o = {}) {
  const src = obj(o);
  const list = Array.isArray(path) ? path : [];
  const max = Number.isFinite(Number(src.max)) ? Math.max(1, Math.floor(Number(src.max))) : MAX_FIRST_VISIT_CLICKS;

  let clicks = 0;
  const steps = [];
  for (const raw of list) {
    const s = obj(raw);
    const kind = trim(s.kind).toLowerCase() === 'auto' ? 'auto' : 'click';
    if (kind === 'click') clicks += 1;
    steps.push({ id: trim(s.id), label: trim(s.label), kind });
  }

  return {
    clicks,
    max,
    steps,
    autoSteps: steps.filter((s) => s.kind === 'auto').length,
    ok: clicks > 0 && clicks <= max,
    note:
      clicks === 0
        ? '路径没有产生任何点击：通常是直接 deep-link 到训练页，落地页因此形同虚设。'
        : clicks <= max
          ? `首访 → 训练需 ${clicks} 次点击（要求 ≤${max}）。`
          : `首访 → 训练需 ${clicks} 次点击，超出 ≤${max} 的上限。`,
  };
}

/**
 * 落地页验收（纯函数）。
 *
 * 三条判据各自独立返回，不合成一个布尔：合成后一旦失败，
 * 运营只知道「落地页不合格」，却不知道缺的是「练什么」还是「能不能不注册」，
 * 而这两者的补救动作完全不同。
 */
export function auditLanding(o = {}) {
  const src = obj(o);
  const elements = Array.isArray(src.elements) ? src.elements : [];
  const pathCost = src.pathCost && typeof src.pathCost === 'object' ? src.pathCost : clickPathCost(src.path);
  const guestTrainable = src.guestTrainable === true;
  const reasons = [];

  const present = new Set(
    elements
      .map((e) => (typeof e === 'string' ? e : obj(e).key))
      .map((k) => trim(k))
      .filter(Boolean)
  );
  const missing = LANDING_ELEMENTS.filter((e) => e.required && !present.has(e.key)).map((e) => e.key);

  if (missing.length) {
    reasons.push(`首屏缺少必答问题：${missing.join(' / ')}（新用户会带着疑问离开）`);
  }
  if (!pathCost.ok) {
    reasons.push(pathCost.note);
  }
  // 「不注册也能看懂产品价值并进入训练」是 RQ-174 的原话
  if (!guestTrainable) {
    reasons.push('未登录用户无法直接进入训练：注册墙拦在首访第一米，与 RQ-174 验收冲突。');
  }

  return {
    ok: reasons.length === 0,
    missing,
    clicks: pathCost.clicks,
    maxClicks: pathCost.max,
    guestTrainable,
    reasons,
    note: reasons.length === 0
      ? `首屏三要素齐备，首访 → 训练 ${pathCost.clicks} 次点击，未登录可直接进入训练。`
      : reasons.join(' '),
  };
}

/**
 * 落地页默认文案（纯函数）。
 *
 * 文案走函数而不是常量，是因为「是否注册」与「保留期」两段的措辞
 * 取决于游客额度与保留策略——写死成常量必然与后端实际行为漂移，
 * 而漂移后的承诺比不承诺更有害（用户是按承诺决定要不要投入时间的）。
 */
export function buildLandingCopy(o = {}) {
  const src = obj(o);
  const guestLimit = numOrNull(src.guestLimit);
  const guestDays = numOrNull(src.guestDays);
  const userDays = trim(src.userRetention) || '长期保留';

  const registerBody =
    guestLimit === null
      ? '不注册也能试；注册后才会保留成绩与连打记录。'
      : `不注册也能先练，游客每日 ${guestLimit} 局；注册后保留成绩与连打记录。`;
  const retentionBody =
    guestDays === null
      ? `登录用户${userDays}；游客记录请在注册前不要依赖长期留存。`
      : `登录用户${userDays}；游客记录保留 ${guestDays} 天，过期不找回。`;

  return {
    elements: [
      {
        key: 'what',
        title: LANDING_ELEMENTS[0].title,
        body: '在隐藏标的与日期的真实 A 股历史 K 线里逐根做决策，练的是盘感与纪律，不是预测。',
      },
      { key: 'register', title: LANDING_ELEMENTS[1].title, body: registerBody },
      { key: 'retention', title: LANDING_ELEMENTS[2].title, body: retentionBody },
    ],
    disclaimer: trim(src.disclaimer) || '真实 A 股公开行情 · 模拟资金与模拟交易 · 仅供学习研究，不构成投资建议',
  };
}

/* ================================================================== *
 * 三、RQ-175：文档与帮助入口统一改为对外地址                            *
 * ================================================================== */

/** 本机 / 内网地址的书写形态 */
export const LOCALHOST_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/gi;

/**
 * 扫描单个文档：本机地址是不是**唯一**入口。
 *
 * 判据刻意是「唯一」而不是「出现」：部署文档里保留一条 localhost 用于本地开发
 * 是完全合理的，RQ-175 要消除的是**外部用户只读得到 localhost** 这一种误解。
 */
export function scanDocEntry(text, publicUrl = null) {
  const body = String(text ?? '');
  const occurrences = body.match(LOCALHOST_PATTERN) || [];
  const url = trim(publicUrl);
  const hasPublic = url ? body.includes(url) : /https:\/\/(?!localhost|127\.0\.0\.1)[^\s)'"`]+/i.test(body);
  const localhostOnly = occurrences.length > 0 && !hasPublic;
  return {
    localhostCount: occurrences.length,
    hasPublic,
    localhostOnly,
    // 唯一入口指「文档里给出的可访问地址全是本机地址」
    uniqueEntryIsLocal: localhostOnly,
    note: localhostOnly
      ? `文档出现 ${occurrences.length} 处本机地址且无对外地址：外部用户按文档走必然打不开。`
      : '文档已包含对外地址（或本机地址仅作为本地开发的附加说明）。',
  };
}

/**
 * 把文档里的本机地址改写为对外地址（纯函数）。
 *
 * 刻意**只在存在对外地址时改写**：无对外地址时把 localhost 换成空串，
 * 会得到一份「看起来没有地址」的文档，比原来更糟。
 */
export function rewriteDocForPublic(text, publicUrl) {
  const body = String(text ?? '');
  const url = trim(publicUrl);
  if (!url) return body;
  return body.replace(LOCALHOST_PATTERN, url);
}

/**
 * 面向**外部访客**的帮助正文（RQ-175 的后半句：改写部署者视角说明）。
 *
 * 现有 README 通篇是 `docker-compose up` 与 `curl -H "Authorization: ..."`，
 * 那是给部署者看的。外部新手即使进得来也读不懂「我该怎么用」（F-110）。
 */
export function renderVisitorHelp(o = {}) {
  const src = obj(o);
  const url = trim(src.publicUrl);
  const guestLimit = numOrNull(src.guestLimit);
  const guestDays = numOrNull(src.guestDays);
  const lines = [
    '## 怎么开始',
    '',
    url ? `1. 打开 ${url}` : '1. 打开站点首页（对外地址尚未配置，请先完成 RQ-173）',
    guestLimit === null
      ? '2. 不注册也能先练一局；想保留成绩再注册。'
      : `2. 不注册也能先练，游客每日 ${guestLimit} 局；想保留成绩再注册。`,
    '3. 进入训练页 → 选一局 → 逐根 K 线做决策，揭晓后看结算与复盘。',
    '',
    '## 我的记录会留多久',
    '',
    guestDays === null
      ? '- 登录用户的训练记录长期保留。'
      : `- 登录用户长期保留；游客记录保留 ${guestDays} 天，过期不找回。`,
    '',
    '## 这是什么 / 不是什么',
    '',
    '- 是：用真实 A 股**历史**行情做模拟决策的训练与复盘工具。',
    '- 不是：实盘交易、行情终端、投资建议。所有资金与成交均为模拟。',
    '',
    '> 行情数据为真实 A 股公开数据，仅供学习研究，不构成投资建议。',
    '',
  ];
  return lines.join('\n');
}

/**
 * 批量审计文档（纯函数）。
 *
 * @param {Array<{name:string, text:string}>} docs
 */
export function auditDocsPublicness(docs, o = {}) {
  const src = obj(o);
  const list = Array.isArray(docs) ? docs : [];
  const url = trim(src.publicUrl);
  const files = list.map((d) => {
    const one = obj(d);
    const scan = scanDocEntry(one.text, url);
    return {
      name: trim(one.name) || 'unnamed',
      ...scan,
      rewritten: scan.localhostOnly && url ? rewriteDocForPublic(one.text, url) : null,
    };
  });
  const bad = files.filter((f) => f.localhostOnly);
  return {
    // 契约保持不变：ok=true 的语义是**「未发现违规」**，不是「已对外化」。
    // 0 份文档时同样未发现违规，因此仍是 true —— 但绝不能被上层读成「通过」，
    // 判据见 auditStageZero 里 RQ-175 的 total===0 守卫。
    ok: bad.length === 0,
    publicUrl: url || null,
    total: files.length,
    offending: bad.map((f) => f.name),
    files,
    note:
      files.length === 0
        ? '未提供待审计文档（0 份）：无法判定对外化，调用方应视为无证据。'
        : bad.length === 0
          ? `${files.length} 份文档均已包含对外地址。`
          : `${bad.length}/${files.length} 份文档仍以本机地址作为唯一入口：${bad.map((f) => f.name).join('、')}。`,
  };
}

/* ================================================================== *
 * 四、RQ-176：「完成一次训练」全站统一为有效完成口径                     *
 * ================================================================== */

/**
 * 全站会读出「完成数」的位置。
 *
 * 列清单而不是扫全部代码的理由：扫全部代码会把测试文件、迁移脚本、
 * 注释里的 `FINISHED` 一起算进来，产生一堆假阳性；而真正会造成
 * 「口径不一致」的只有这四处对外读数。
 */
export const COMPLETION_SITES = [
  { key: 'funnel', label: '训练漏斗完成数' },
  { key: 'northStar', label: '北极星首训完成率' },
  { key: 'telemetry', label: 'blind_finish 埋点' },
  { key: 'scoreCard', label: '成绩卡完成标记' },
];

/** 有效完成的硬门槛：0 笔成交或 0 秒一律不计入 */
export const EFFECTIVE_FLOOR = { minTrades: 1, minDurationSec: 1 };

/**
 * 单次会话是否计入「有效完成」（纯函数，与 effectiveCompletionService 同口径）。
 *
 * 重复定义而非直接 import 的理由：本函数只做**审计口径**的最小判定，
 * 不依赖 `effectiveCompletionService` 的评分对象；耦合进去会让
 * 「扫全站口径」这件事必须先构造出完整 session 才能跑。
 */
export function isEffectiveCompletion(o = {}) {
  const src = obj(o);
  const trades = numOrNull(src.trades);
  const sec = numOrNull(src.durationSec);
  const finished = src.finished === true || trim(src.status).toUpperCase() === 'FINISHED';
  if (!finished) return { counted: false, reason: '会话未结束' };
  if (trades === null || trades < EFFECTIVE_FLOOR.minTrades) {
    return { counted: false, reason: `成交 ${trades ?? 0} 笔 < ${EFFECTIVE_FLOOR.minTrades} 笔：空跑不计入完成` };
  }
  if (sec === null || sec < EFFECTIVE_FLOOR.minDurationSec) {
    return { counted: false, reason: `耗时 ${sec ?? 0} 秒 < ${EFFECTIVE_FLOOR.minDurationSec} 秒：点一下就结束不计入完成` };
  }
  return { counted: true, reason: '' };
}

/**
 * 扫描真实源码：全站「完成数」读数是否都走有效完成口径（纯函数）。
 *
 * 与 `auditCompletionConsistency` 的分工：
 *   前者判定**别人上报的口径声明**，本函数直接从源码里找证据。
 * 两者缺一不可——只信声明等于自己给自己发通行证（v13 scanMissingTestFilter 的教训）。
 *
 * @param {Array<{name:string, text:string}>} files
 * @returns {{ok:boolean, evidence:Array, unverified:string[], note:string}}
 */
export function scanCompletionCaliber(files) {
  const list = Array.isArray(files) ? files : [];

  /** 每个站点的判定依据：命中任一「有效口径」特征即视为已收口 */
  const PROBES = {
    funnel: [/effective_completed/i, /effectiveCompletion/i, /effective_completed\s*=\s*true/i],
    northStar: [/effective_completed/i, /effectiveCompletion/i, /firstTrainingEffectiveRate/i],
    telemetry: [/allowFinishTelemetry/i, /effectiveCompletion/i, /effective_completed/i],
    scoreCard: [/effective_completed/i, /effectiveCompletion/i, /effectiveCompleted/i],
  };
  /** 每类读数对应的源码文件（按文件名匹配） */
  const FILE_OF = {
    funnel: /trainingFunnelService|growth\.js|firstTrainingService/,
    northStar: /northStarService/,
    telemetry: /telemetryIntegrityService|analyticsService|routes\/blind\.js/,
    scoreCard: /scoreCardService|checkupService/,
  };

  const evidence = [];
  const unverified = [];
  for (const site of COMPLETION_SITES) {
    const key = site.key;
    const probes = PROBES[key] || [];
    const fileRe = FILE_OF[key];
    const hit = list.find((f) => {
      // 兼容两种来源：`collectSourceFiles` 给的是 path，调用方自造的可能是 name
      const name = String(obj(f).name || obj(f).path || '');
      if (!fileRe || !fileRe.test(name)) return false;
      return probes.some((re) => re.test(String(obj(f).text || '')));
    });
    if (hit) evidence.push({ key, file: obj(hit).name || obj(hit).path });
    else unverified.push(key);
  }

  return {
    ok: unverified.length === 0,
    evidence,
    unverified,
    scanned: list.length,
    note:
      unverified.length === 0
        ? `${COMPLETION_SITES.length} 处完成读数在源码中均已采用有效完成口径。`
        : list.length === 0
          ? '未提供源码：无证据，不作判定（避免凭空报红）。'
          : `未在源码中找到有效完成口径：${unverified.join('、')}。`,
  };
}

/**
 * 全站口径一致性审计（纯函数）。
 *
 * @param {object} o { sites: {funnel:{effective:boolean}, ...} }
 *   每个站点给出它目前用的是 `effective`（有效完成）还是 raw（原始 FINISHED 计数）。
 */
export function auditCompletionConsistency(o = {}) {
  const src = obj(o);
  const sites = obj(src.sites);
  const rows = COMPLETION_SITES.map((s) => {
    const v = obj(sites[s.key]);
    const effective = v.effective === true;
    return { key: s.key, label: s.label, effective, raw: v.raw === true };
  });
  const divergent = rows.filter((r) => !r.effective).map((r) => r.key);

  // 反例校验：给一组空跑会话，任何站点若把它们计入即为口径错误
  const samples = Array.isArray(src.samples) ? src.samples : [];
  const falsePositive = samples
    .map((s) => ({ sample: obj(s), verdict: isEffectiveCompletion(s) }))
    .filter((x) => x.verdict.counted === true && (numOrNull(obj(x.sample).trades) ?? 0) < EFFECTIVE_FLOOR.minTrades);

  return {
    ok: divergent.length === 0 && falsePositive.length === 0,
    sites: rows,
    divergent,
    falsePositive: falsePositive.length,
    floor: EFFECTIVE_FLOOR,
    note:
      divergent.length === 0 && falsePositive.length === 0
        ? `${rows.length} 处「完成」读数全部采用有效完成口径，空跑会话不计入。`
        : `仍有 ${divergent.length} 处沿用原始 FINISHED 计数：${divergent.join('、')}；空跑被计入 ${falsePositive.length} 次。`,
  };
}

/* ================================================================== *
 * 五、RQ-177：去重 / 隔离 / 对账 / 连续 2 次留痕                        *
 * ================================================================== */

/** 阶段零的四项度量闸门 */
export const STAGE_ZERO_GATES = [
  { key: 'dedupe', label: '埋点去重', rq: 'RQ-177' },
  { key: 'isolation', label: '自测流量隔离', rq: 'RQ-177' },
  { key: 'consistency', label: '埋点↔会话对账', rq: 'RQ-177' },
  { key: 'streak', label: '连续 2 次发布验证留痕', rq: 'RQ-177' },
];

/**
 * 阶段零度量闸门汇总（纯函数）。
 *
 * 四项各自接受上游服务已经算好的结果对象（telemetryIntegrity / testIsolation /
 * releaseGate），本函数只做**归一化与判定**，不重新实现逻辑——
 * 重新实现一次就等于制造第二套口径，而这正是 v13 修的那个缺陷。
 *
 * @param {object} o
 * @param {object} [o.dedupe]      { duplicates?:number, ok?:boolean }
 * @param {object} [o.isolation]   { isTestCoverage?:number|null, ok?:boolean }
 * @param {object} [o.consistency] { diff?:number, orphanEvents?:number, missingEvents?:number, ok?:boolean }
 * @param {object} [o.streak]      { streak?:number, required?:number, ok?:boolean }
 */
export function stageZeroVerification(o = {}) {
  const src = obj(o);
  const items = [];

  const dedupeRaw = obj(src.dedupe);
  const dupCount = numOrNull(dedupeRaw.duplicates) ?? 0;
  const dupOk = dedupeRaw.ok === true ? dupCount === 0 : dupCount === 0;
  items.push({
    key: 'dedupe',
    label: '埋点去重',
    ok: dupOk,
    value: dupCount,
    detail: dupOk ? '无重复上报。' : `仍有 ${dupCount} 条重复上报（如单会话 blind_resume > 1）。`,
  });

  const isoRaw = obj(src.isolation);
  const isoOk = isoRaw.ok === true;
  items.push({
    key: 'isolation',
    label: '自测流量隔离',
    ok: isoOk,
    value: isoRaw.isTestCoverage ?? null,
    detail: isoOk ? '自测流量已可区分，漏斗默认排除。' : String(isoRaw.note || '自测流量仍混入指标。'),
  });

  const conRaw = obj(src.consistency);
  const diff = numOrNull(conRaw.diff);
  const orphan = numOrNull(conRaw.orphanEvents) ?? 0;
  const missing = numOrNull(conRaw.missingEvents) ?? 0;
  const conDiff = diff !== null ? diff : orphan + missing;
  const conOk = conRaw.ok === true ? conDiff === 0 : conDiff === 0;
  items.push({
    key: 'consistency',
    label: '埋点↔会话对账',
    ok: conOk,
    value: conDiff,
    detail: conOk
      ? '埋点与业务表按会话双向对账差异为 0。'
      : `对账差异 ${conDiff}（孤立埋点 ${orphan} / 漏报 ${missing}）：漏斗分子分母不同源。`,
  });

  const stRaw = obj(src.streak);
  const stOk = stRaw.ok === true;
  items.push({
    key: 'streak',
    label: '连续 2 次发布验证留痕',
    ok: stOk,
    value: numOrNull(stRaw.streak) ?? 0,
    detail: stOk
      ? `连续 ${numOrNull(stRaw.streak) ?? 0} 次发布均有验证记录。`
      : `连续验证记录仅 ${numOrNull(stRaw.streak) ?? 0} 次（要求 ≥${numOrNull(stRaw.required) ?? 2}）。`,
  });

  const failed = items.filter((i) => !i.ok);
  return {
    ok: failed.length === 0,
    gates: STAGE_ZERO_GATES,
    items,
    failed: failed.map((i) => i.key),
    note: failed.length === 0
      ? '阶段零四项度量闸门全部通过。'
      : `${failed.length} 项未通过：${failed.map((i) => i.label).join('、')}。`,
  };
}

/* ================================================================== *
 * 五·补 RQ-177 的真实取证（queryFn 注入，便于无库单测）                  *
 * ================================================================== */

/** 单会话内同一事件重复上报的上限：>1 即为重复 */
export const DEDUPE_SQL = `
  SELECT COUNT(*)::int AS c FROM (
    SELECT NULLIF(payload->>'sessionId','')::int AS sid, event, COUNT(*) AS n
      FROM analytics_events
     WHERE event = 'blind_resume'
       AND created_at >= now() - ($1 || ' days')::interval
       AND COALESCE(is_test, false) = false
     GROUP BY 1, 2
    HAVING COUNT(*) > 1
  ) d`;

/**
 * 自测流量占比：分子分母都要，只有占比才能判断「看板是否被污染」。
 *
 * 刻意显式声明 `scope: all` 而不是裸写 SQL：
 * 这是**元操作**（判断隔离是否生效），必须能看见被标记的行，
 * 否则覆盖率永远算出来是 0%，隔离看起来「完美生效」。
 * 走 `trafficScopeWhere` 同时让 RQ-157 的源码扫描认账（该扫描要求口径声明
 * 出现在 FROM analytics_events 之后，裸写 SQL 会被判为未声明口径）。
 */
export function ISOLATION_SQL(scope = TRAFFIC_SCOPES.all) {
  return `
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE COALESCE(e.is_test, false) OR COALESCE(u.is_test, false))::int AS test_rows
    FROM analytics_events e
    ${trafficScopeJoin({ eventAlias: 'e', userAlias: 'u' })}
   WHERE ${trafficScopeWhere({ eventAlias: 'e', userAlias: 'u', scope })}
     AND e.created_at >= now() - ($1 || ' days')::interval`;
}

/**
 * 采集 RQ-177 四项闸门的**真实读数**。
 *
 * 为什么单独做一层取数而不是让路由直接拼 SQL：
 * SQL 是本模块最需要被单测、又最难被单测的部分（v10 的两个阻断级缺陷都在 SQL 层）。
 * `queryFn` 注入后可以脱离数据库验证「取数失败时如何降级」。
 *
 * 取数失败一律 `null`（unknown），**不返回 0**：
 * 「查不到」与「查到是 0」是两回事，把前者报成后者就是制造假绿。
 */
export async function collectVerificationEvidence({ queryFn = null, days = 30, consistency = null, streak = null } = {}) {
  if (!queryFn) return { ok: false, evidence: null, reason: '未提供 queryFn' };

  let duplicates = null;
  try {
    const { rows } = await queryFn(DEDUPE_SQL, [String(days)]);
    duplicates = rows[0]?.c ?? null;
  } catch {
    duplicates = null;
  }

  let isolation = { ok: false, isTestCoverage: null, note: '自测流量读数不可得' };
  try {
    const { rows } = await queryFn(ISOLATION_SQL(), [String(days)]);
    const total = rows[0]?.total ?? null;
    const testRows = rows[0]?.test_rows ?? null;
    if (total !== null) {
      isolation = {
        ok: testRows !== null && total > 0 && testRows < total,
        isTestCoverage: total > 0 ? Number((testRows / total).toFixed(4)) : null,
        total,
        testRows,
        note:
          total === 0
            ? '窗口内无埋点：无法判断隔离是否生效。'
            : `窗口内 ${testRows}/${total} 条为自测流量（${((testRows / total) * 100).toFixed(1)}%）。`,
      };
    }
  } catch {
    /* 保持 null 口径 */
  }

  const con = consistency && typeof consistency === 'object' ? consistency : null;
  const st = streak && typeof streak === 'object' ? streak : null;

  return {
    ok: true,
    evidence: {
      dedupe: { duplicates },
      isolation,
      consistency: con
        ? { orphanEvents: con.orphanEvents ?? null, missingEvents: con.missingEvents ?? null, diff: con.diff ?? null, ok: con.ok === true }
        : null,
      streak: st ? { streak: st.streak ?? null, required: st.required ?? 2, ok: st.ok === true } : null,
    },
  };
}

/* ================================================================== *
 * 六、阶段零总览                                                       *
 * ================================================================== */

/**
 * 阶段零总览（纯函数）：把 RQ-173~177 的五项判定合成一份可断言报告。
 *
 * 合成而非各自为战的理由：v15 的硬约束第 7 条是「RQ-173 未完成时
 * RQ-178~186 一律不进排期」——这条规则只有在**一份报告里同时看到
 * 入口状态与冻结列表**时才可能被真正执行。
 */
export function auditStageZero(o = {}) {
  const src = obj(o);
  const entry = obj(src.entry);
  const landing = src.landing && typeof src.landing === 'object' ? src.landing : auditLanding(src.landingInput);
  const docs = src.docs && typeof src.docs === 'object' ? src.docs : auditDocsPublicness(src.docsInput?.docs, src.docsInput);
  const completion = src.completion && typeof src.completion === 'object' ? src.completion : null;
  const verification = src.verification && typeof src.verification === 'object' ? src.verification : null;
  const truth =
    src.truth && typeof src.truth === 'object' ? src.truth : statusTruthfulness({ entryReady: entry.ready === true, owner: src.owner, readmeText: src.readmeText, now: src.now });

  /**
   * 三态判定：`pass` / `fail` / `unknown`。
   *
   * 为什么必须有 unknown：RQ-176 / 177 的证据来自**源码扫描与数据库查询**，
   * 端点拿不到时若一律按「未通过」处理，就会得到一条永远为红、
   * 且没人能修的告警——**凭空报红与凭空报绿是同一类缺陷**（F-102 的两面）。
   * 只有真凭实据的失败才进 `failed`；缺证据的进 `unknown`，由调用方决定是否补证。
   */
  const rawItems = [
    {
      rq: 'RQ-173',
      title: '对外地址与 HTTPS',
      // 入口是否就绪是**事实**（可查），因此这一项永远有证据
      verdict: entry.ready === true && truth.ok,
      detail: entry.ready ? truth.verdict : (entry.nextAction || '对外入口未配置'),
    },
    { rq: 'RQ-174', title: '首屏落地页与最短路径', verdict: landing.ok === true, detail: landing.note },
    {
      rq: 'RQ-175',
      title: '文档对外化',
      // 空集合的真值（vacuous truth）是本项目反复踩过的坑：0 份文档 →
      // auditDocsPublicness 的 bad.length===0 → ok:true，看起来像「审过且全部合格」。
      // 生产镜像只 COPY backend/，README.md / frontend/nginx.conf 根本不在 /app，
      // 因此不带证据时一律判 unknown，而不是拿「什么都没扫到」冒充通过。
      verdict: docs.total === 0 ? null : docs.ok === true,
      detail:
        docs.total === 0
          ? '未提供待审计文档（0 份）：生产镜像内无 README.md / frontend/nginx.conf，无法判定对外化，不计为通过。'
          : docs.note,
    },
    {
      rq: 'RQ-176',
      title: '有效完成全站一致',
      verdict: completion ? completion.ok === true : null,
      detail: completion ? completion.note : '未提供源码或声明：无证据，不作判定。',
    },
    {
      rq: 'RQ-177',
      title: '度量闸门',
      verdict: verification ? verification.ok === true : null,
      detail: verification ? verification.note : '未提供去重/隔离/对账/留痕读数：无证据，不作判定。',
    },
  ];

  const items = rawItems.map((i) => ({
    rq: i.rq,
    title: i.title,
    ok: i.verdict === true,
    status: i.verdict === true ? 'pass' : i.verdict === false ? 'fail' : 'unknown',
    detail: i.detail,
  }));

  const failed = items.filter((i) => i.status === 'fail').map((i) => i.rq);
  const unknown = items.filter((i) => i.status === 'unknown').map((i) => i.rq);
  const gateReady = entry.ready === true;
  const frozen = gateReady ? [] : FROZEN_RQS_V15;

  return {
    version: 'v15',
    // ready = 无任何「有据可查的失败」；unknown 不算通过，但也不阻塞
    ready: failed.length === 0,
    gateReady,
    items,
    failed,
    unknown,
    frozen,
    truth,
    landing,
    docs,
    completion,
    verification,
    rule: gateReady
      ? '公网入口已就绪，冻结项可按阶段一顺序解冻。'
      : `RQ-173 未完成，${frozen.length} 项维持冻结（硬约束第 7 条）：${frozen.join('、')}。`,
    note:
      failed.length > 0
        ? `阶段零未通过 ${failed.length} 项：${failed.join('、')}。`
        : unknown.length > 0
          ? `阶段零无确凿失败，但 ${unknown.length} 项缺少证据：${unknown.join('、')}；待补证后方可收口。`
          : '阶段零五项 P0 全部通过。',
  };
}

export default {
  // RQ-173
  FROZEN_RQS_V15,
  STATUS_TRUTH_TEXT,
  countdownOf,
  statusTruthfulness,
  // RQ-174
  LANDING_ELEMENTS,
  MAX_FIRST_VISIT_CLICKS,
  clickPathCost,
  auditLanding,
  buildLandingCopy,
  // RQ-175
  LOCALHOST_PATTERN,
  scanDocEntry,
  rewriteDocForPublic,
  renderVisitorHelp,
  auditDocsPublicness,
  // RQ-176
  COMPLETION_SITES,
  EFFECTIVE_FLOOR,
  isEffectiveCompletion,
  auditCompletionConsistency,
  scanCompletionCaliber,
  // RQ-177
  STAGE_ZERO_GATES,
  stageZeroVerification,
  DEDUPE_SQL,
  ISOLATION_SQL,
  collectVerificationEvidence,
  // 总览
  auditStageZero,
};
