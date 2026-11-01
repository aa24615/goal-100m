/**
 * 自测流量隔离（RQ-157）
 *
 * v13 §4 F-89 的实测读数：**`analytics_events` 4521 条，`is_test` 全为 f**，
 * 其中 user 3 一个人贡献 4364 条（`blind_start` 317 次）。
 * 也就是说：**当前所有看板的分母里都混着压测流量**，12 个用户这个数字无法反映真实情况。
 *
 * 更麻烦的是 v12 已经把「打标」做出来了（`testTrafficService.applyTestMarks`），
 * 但打标**只改了数据，没改读取口径**——`analyticsService` / `firstTrainingService`
 * 这些真正的看板查询里连 `is_test` 四个字母都没出现过。
 * 于是出现一种最坏的组合：**标打上了，看板照旧全量读**，指标一分钱没变干净。
 *
 * 本模块做三件事，把「默认排除」从一句要求变成跑不掉的机制：
 *
 *   1. **统一口径契约**：`trafficScopeWhere()` 是唯一事实来源。任何看板查询都要拼它，
 *      不允许各处自己手写 `is_test = FALSE`（手写会漏，漏了没人知道）。
 *   2. **写入侧自动判定**：`classifyIngest()` 在埋点入库前就判出这是不是自测流量，
 *      而不是等事后批量打标——**事后打标永远追不上新产生的污染**（这是 v12 的教训）。
 *   3. **缺失过滤器的静态审计**：`scanMissingTestFilter()` 扫描所有读 `analytics_events`
 *      的源文件，未声明口径且不在豁免名单里的一律报缺陷。
 *      这一条是关键：**没有它，下一个人加一张看板时又会忘记过滤**。
 *
 * 设计约束：纯函数为主，SQL 只在这里定义一次（v8 起的分层约定）。
 */

/** 流量口径 */
export const TRAFFIC_SCOPES = {
  /** 真实流量：看板默认口径（RQ-157 验收「默认看板不可见」） */
  real: 'real',
  /** 测试流量：用于核对打标是否生效 */
  test: 'test',
  /** 全量：只允许口径审查、去重清理这类元操作使用 */
  all: 'all',
};

/** 看板默认口径 —— RQ-157 的硬要求：不显式声明 scope 时必须是 real */
export const DEFAULT_TRAFFIC_SCOPE = TRAFFIC_SCOPES.real;

/**
 * 允许读取全量的文件（必须写清理由）。
 *
 * 为什么需要豁免：去重（RQ-143）与清理必须看全量，否则被标记的行反而看不见了；
 * 但豁免一旦没有理由就会膨胀成「所有地方都豁免」，所以每一项都必须附 reason。
 */
/**
 * 允许读取全量的文件（必须写清理由，且只允许「按单 user 取数」或「元操作」）。
 *
 * 注意这里**不放任何聚合看板**：看板必须逐条查询自己声明口径。
 * 一旦某个看板进了豁免名单，「默认排除测试流量」这条硬要求就名存实亡了
 * ——这正是 v12 的真实状态：打标有了，看板照旧全量读，指标一分钱没干净。
 */
export const FULL_SCOPE_READERS = [
  { file: 'services/telemetryIntegrityService.js', reason: '去重/清理/审计的元操作，必须看全量才能发现污染' },
  { file: 'services/testTrafficService.js', reason: '打标与用户构成统计，需要分别读 real 与 test' },
  { file: 'services/northStarService.js', reason: '按 user_id 逐人取注册渠道，非聚合看板；是否为测试用户由 isExternalUser 单独判定' },
  { file: 'services/onboardingService.js', reason: '按单个 user_id 计数（引导进度），非聚合看板' },
  { file: 'services/testIsolationService.js', reason: '本模块自带注释示例与 SQL 契约本身，不查询业务表' },
];

function norm(v) {
  return String(v ?? '').trim();
}

/**
 * 口径对应的 JOIN 子句。
 *
 * 必须显式 LEFT JOIN users：只判 `analytics_events.is_test` 会漏掉
 * 「用户已被打标、但历史事件还没打标」这种情况——而这种情况正是当前 4521 条脏数据的主体。
 */
export function trafficScopeJoin({ eventAlias = 'e', userAlias = 'u', userTable = 'users' } = {}) {
  return `LEFT JOIN ${userTable} ${userAlias} ON ${userAlias}.id = ${eventAlias}.user_id`;
}

/**
 * 口径对应的 WHERE 条件（唯一事实来源）。
 *
 * `real` 采用「事件没打标 **且** 用户也没打标」的双重判定（AND），
 * `test` 采用「事件或用户任一打标」的并集判定（OR）。
 * 两者刻意不对称：real 取交集是为了**宁可少算也不把测试算进来**；
 * test 取并集是为了**一次性能看清全部污染规模**。
 */
export function trafficScopeWhere({ eventAlias = 'e', userAlias = 'u', scope = DEFAULT_TRAFFIC_SCOPE } = {}) {
  const s = String(scope ?? '').trim().toLowerCase();
  if (s === TRAFFIC_SCOPES.all) return 'TRUE';
  if (s === TRAFFIC_SCOPES.test) {
    return `(${eventAlias}.is_test = TRUE OR COALESCE(${userAlias}.is_test, FALSE) = TRUE)`;
  }
  return `(${eventAlias}.is_test = FALSE AND COALESCE(${userAlias}.is_test, FALSE) = FALSE)`;
}

/** 从请求 query 解析口径：不传 = real；非法值回落 real（绝不因为拼错参数就把测试流量放进来） */
export function boardScopeOf(query, o = {}) {
  const q = query && typeof query === 'object' ? query : {};
  const raw = norm(q.scope || q.traffic || o.default || DEFAULT_TRAFFIC_SCOPE).toLowerCase();
  return TRAFFIC_SCOPES[raw] ? raw : DEFAULT_TRAFFIC_SCOPE;
}

/* ------------------------------------------------------------------ *
 * 二、写入侧自动判定（根因治理）                                        *
 * ------------------------------------------------------------------ */

/** 自动化 UA 特征：命中即判为自测流量 */
export const AUTOMATION_UA = /headless|playwright|puppeteer|selenium|k6|jmeter|locust|autocannon|python-requests|curl\/|node-fetch/i;

/**
 * 判定一次埋点上报是否为自测流量。
 *
 * 判定顺序刻意从「强证据」到「弱证据」：
 *   ① 显式声明（客户端自报 / 压测开关）→ ② 用户已打标 → ③ UA 自动化特征 → ④ 私网来源。
 * 强证据命中即返回，不再叠加弱证据，避免出现「理由串成一串看不懂」的情况。
 *
 * @returns {{isTest:boolean, reason:string, source:string}}
 */
export function classifyIngest(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const body = src.body && typeof src.body === 'object' ? src.body : {};
  // 注意：不能在自己的初始化器里引用同名 const（TDZ 下 `typeof headers` 会抛 ReferenceError，
  // 与「未声明变量返回 undefined」不同）——v12 在 effectiveCompletionService 里踩过同一个坑。
  const headers = src.headers && typeof src.headers === 'object' ? src.headers : {};
  const user = src.user && typeof src.user === 'object' ? src.user : null;
  const env = src.env && typeof src.env === 'object' ? src.env : {};

  if (src.isTest === true || body.isTest === true || norm(headers['x-test-mode']) === '1' || norm(env.TEST_MODE) === '1') {
    return { isTest: true, reason: '显式声明为测试流量', source: 'declared' };
  }
  if (user && user.is_test === true) {
    return { isTest: true, reason: `用户已打标（${norm(user.test_reason) || '未注明原因'}）`, source: 'user-marked' };
  }
  const ua = norm(headers['user-agent'] || headers.ua || src.ua);
  if (ua && AUTOMATION_UA.test(ua)) {
    return { isTest: true, reason: `自动化 UA：${ua.slice(0, 60)}`, source: 'ua' };
  }
  if (src.privateIp === true) {
    return { isTest: true, reason: '来源为内网/本机地址', source: 'ip' };
  }
  return { isTest: false, reason: '未命中任何测试特征', source: 'none' };
}

/* ------------------------------------------------------------------ *
 * 三、缺失过滤器的静态审计                                              *
 * ------------------------------------------------------------------ */

/**
 * 扫描源文件，找出「读了 analytics_events 但没声明口径」的读点。
 *
 * @param {Array} files [{path, text}]
 * @param {Array} [allowlist] 豁免名单
 * @returns {{ok:boolean, checked:number, offenders:Array, exempt:Array}}
 */
/**
 * 扫描源文件，找出「读了 analytics_events 但没声明口径」的读点。
 *
 * **按「每一条查询」判而不是按「每个文件」判**——这一点决定了这个检查有没有用。
 * 按文件判时，只要某个文件里有一处写了 `is_test`（哪怕是完全无关的那一行），
 * 整份文件就被判通过，新增的未过滤查询会被顺带放过。
 * v12 的 `analyticsService` 正是这样：整份文件里有一处 `is_test`（而且是与之无关的那一处），
 * 文件级检查全绿，看板的 SQL 里却一个 `is_test` 都没有。
 *
 * 因此实现为：定位每一次 `FROM analytics_events`，取其后 WINDOW_CHARS 个字符作为
 * 这条查询的上下文，只有在**这段上下文里**出现口径标记才算通过。
 *
 * @param {Array} files [{path, text}]
 * @param {Array} [allowlist] 豁免名单（仅「按单 user 取数」与元操作）
 * @returns {{ok:boolean, checked:number, offenders:Array, exempt:Array}}
 */
export const SCOPE_WINDOW_CHARS = 600;

export function scanMissingTestFilter(files, allowlist = FULL_SCOPE_READERS) {
  const list = Array.isArray(files) ? files : [];
  const allow = Array.isArray(allowlist) ? allowlist : [];

  const offenders = [];
  const exempt = [];
  let checked = 0;

  for (const f of list) {
    // 路径分隔符归一化：Windows 下是 `src\services\x.js`，豁免名单统一写 POSIX 分隔符
    const path = norm(f?.path).replace(/\\/g, '/');
    const text = String(f?.text ?? '');
    if (!text) continue;

    const allowHit = allow.find((a) => path.endsWith(norm(typeof a === 'string' ? a : a?.file)));
    const spots = [];

    for (const m of text.matchAll(/FROM\s+analytics_events\b/gi)) {
      const at = m.index ?? 0;
      // 排除写入类语句（INSERT INTO ... SELECT / DELETE ... FROM）
      const before = text.slice(Math.max(0, at - 120), at).toLowerCase();
      if (/\bdelete\b|\binsert\s+into\b|\bupdate\b/.test(before)) continue;
      // 上下文取到**这条语句结束**为止（模板字符串用反引号收尾），再兜底 600 字符。
      // 固定 600 字符会在短文件里跨到下一条查询，于是「一条声明了口径」会把
      // 紧随其后的未声明查询一起判通过 —— 这正是 v12 analyticsService 漏掉的方式。
      const rest = text.slice(at);
      const endRel = rest.search(/[`;]/);
      const win = endRel > 0 ? Math.min(SCOPE_WINDOW_CHARS, endRel) : SCOPE_WINDOW_CHARS;
      spots.push({ at, context: rest.slice(0, win) });
    }
    if (spots.length === 0) continue;

    const bad = spots.filter((s) => !/is_test|trafficScopeWhere|boardScopeOf/i.test(s.context));
    checked += spots.length;

    for (const s of bad) {
      const line = text.slice(0, s.at).split('\n').length;
      if (allowHit) {
        exempt.push({ path, line, reason: allowHit.reason || '已登记豁免' });
      } else {
        offenders.push({
          path,
          line,
          problem: '读取 analytics_events 但该查询未声明流量口径，测试流量会混入看板（F-89）',
          fix: '用 trafficScopeWhere({ scope: boardScopeOf(req.query) }) 拼 WHERE，并配合 trafficScopeJoin() LEFT JOIN users',
        });
      }
    }
  }

  return { ok: offenders.length === 0, checked, offenders, exempt };
}

/* ------------------------------------------------------------------ *
 * 四、去重契约的读数校验（RQ-157「单用户单会话 ≤1」）                    *
 * ------------------------------------------------------------------ */

/**
 * 校验「单用户单会话 blind_resume ≤ 1」。
 *
 * 为什么还要在读取侧再校验一次：唯一索引只在**写入**时生效，
 * 而历史 715 条是在索引建立之前写进去的（v12 迁移 0020 只对新数据生效）。
 * 不看这一段，需求文档就会写「已去重」，而表里躺着 715 条。
 *
 * @param {Array} rows [{subject, sessionId, count}]
 * @param {object} o {limit=1}
 */
export function auditResumeDedupe(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number.isFinite(Number(o?.limit)) ? Math.max(1, Math.floor(Number(o.limit))) : 1;
  const groups = new Map();
  for (const r of list) {
    const key = `${norm(r?.subject)}|${norm(r?.sessionId)}`;
    groups.set(key, (groups.get(key) || 0) + (Number.isFinite(Number(r?.count)) ? Number(r.count) : 0));
  }
  const violations = [...groups.entries()]
    .filter(([, c]) => c > limit)
    .map(([key, c]) => {
      const [subject, sessionId] = key.split('|');
      return { subject, sessionId, count: c, over: c - limit };
    });
  return {
    limit,
    groups: groups.size,
    total: [...groups.values()].reduce((s, c) => s + c, 0),
    violations,
    ok: violations.length === 0,
    detail: violations.length === 0
      ? `全部 ${groups.size} 个「主体+会话」组内计数均 ≤ ${limit}`
      : `${violations.length} 个组超过 ${limit} 条（历史污染，需打标或清理）`,
  };
}

/* ------------------------------------------------------------------ *
 * 四·补 历史污染打标（RQ-157「历史 715 条 blind_resume 已打标或清理」）    *
 * ------------------------------------------------------------------ */

/**
 * 历史埋点打标的 SQL（默认 dry-run，加 apply 才写）。
 *
 * 两条规则，都只做**打标**不做删除（RK-03 的可逆性要求）：
 *   - `userMarked`：用户已被判为自测，其历史事件一并打标。
 *     只判 `analytics_events.is_test` 会漏掉这一类——而它正是 4521 条脏数据的主体。
 *   - `resumeDup`：同一「主体 + 会话」的 `blind_resume` 只保留最早一条为真实，
 *     其余打标。索引只对**新数据**生效，715 条是索引建立之前写进去的（v12 0020）。
 */
export const MARK_SQL = {
  userMarked: `
    UPDATE analytics_events e
       SET is_test = TRUE
      FROM users u
     WHERE u.id = e.user_id
       AND u.is_test = TRUE
       AND e.is_test = FALSE`,
  /** $1 = 需要打标的 id 数组（由 pickDuplicateResumeIds 纯函数算出，不在 SQL 里做窗口判断） */
  resumeDup: `
    UPDATE analytics_events
       SET is_test = TRUE
     WHERE id = ANY($1::int[])
       AND is_test = FALSE`,
  /**
   * 会话级传播：会话已被判为自测，其 blind_* 事件一并打标。
   *
   * 为什么需要第三条规则：v12 的打标只覆盖 users 与 blind_sessions，
   * 而埋点行与之是**分别落库**的。于是出现「会话标了、事件没标」，
   * 埋点对账（RQ-158）就会把这一局算成「埋点记了不存在的会话」——
   * 本次上线实测正是这样抓到 event#4528(session=324) 的。
   */
  sessionMarked: `
    UPDATE analytics_events e
       SET is_test = TRUE
      FROM blind_sessions s
     WHERE s.is_test = TRUE
       AND s.id = NULLIF(e.payload->>'sessionId','')::int
       AND e.is_test = FALSE`,
  /** 计数用：不动数据 */
  countSessionMarked: `
    SELECT COUNT(*)::int AS c
      FROM analytics_events e
      JOIN blind_sessions s ON s.id = NULLIF(e.payload->>'sessionId','')::int
     WHERE s.is_test = TRUE AND e.is_test = FALSE`,
  countUserMarked: `
    SELECT COUNT(*)::int AS c
      FROM analytics_events e
      JOIN users u ON u.id = e.user_id
     WHERE u.is_test = TRUE AND e.is_test = FALSE`,
  countResume: `
    SELECT id,
           COALESCE(e.user_id::text, NULLIF(e.payload->>'guestToken',''), 'anon') AS subject,
           NULLIF(e.payload->>'sessionId','') AS session_id
      FROM analytics_events e
     WHERE e.event = 'blind_resume'
       AND e.is_test = FALSE
     ORDER BY e.id ASC`,
};

/**
 * 从 blind_resume 行里挑出「同一主体+会话的第 2 条及以后」（纯函数）。
 *
 * 为什么不在 SQL 里用窗口函数：窗口函数写起来短，但**无法单测**，
 * 而这正是要在发布验证里锁死的一条规则。放在纯函数里，715 条的历史形态
 * 可以用 fixture 直接复刻。
 *
 * @param {Array} rows 已按 id 升序的 [{id, subject, session_id}]
 * @returns {number[]} 需要打标的 id
 */
export function pickDuplicateResumeIds(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const dup = [];
  for (const r of list) {
    const sid = String(r?.session_id ?? '').trim();
    // 缺 sessionId 的行不参与去重：没有会话维度就退化成「按主体去重」，会误削真实行为
    if (!sid) continue;
    const key = `${String(r?.subject ?? '').trim()}|${sid}`;
    if (seen.has(key)) dup.push(Number(r?.id));
    else seen.add(key);
  }
  return dup.filter((n) => Number.isFinite(n));
}

/**
 * 历史打标计划（只读，不写库）。
 * @param {object} o { queryFn }
 */
export async function planHistoricalMarks({ queryFn = null } = {}) {
  if (!queryFn) return { ok: false, reason: '未提供 queryFn', userMarked: 0, sessionMarked: 0, resumeDup: 0, resumeIds: [] };
  try {
    const [{ rows: c }, { rows: cs }, { rows: rs }] = await Promise.all([
      queryFn(MARK_SQL.countUserMarked, []),
      queryFn(MARK_SQL.countSessionMarked, []),
      queryFn(MARK_SQL.countResume, []),
    ]);
    const resumeIds = pickDuplicateResumeIds(rs);
    const userMarked = Number(c[0]?.c ?? 0) || 0;
    const sessionMarked = Number(cs[0]?.c ?? 0) || 0;
    return {
      ok: true,
      userMarked,
      sessionMarked,
      resumeDup: resumeIds.length,
      resumeScanned: rs.length,
      resumeIds,
      note: `计划打标：用户级 ${userMarked} 条、会话级 ${sessionMarked} 条、blind_resume 重复 ${resumeIds.length} 条（共扫描 ${rs.length} 条）。`,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e), userMarked: 0, sessionMarked: 0, resumeDup: 0, resumeIds: [] };
  }
}

/**
 * 执行历史打标。默认 dry-run（RQ-157 的删除/改写一律先可预演）。
 * @param {object} o { queryFn, apply=false }
 */
export async function applyHistoricalMarks({ queryFn = null, apply = false } = {}) {
  const plan = await planHistoricalMarks({ queryFn });
  if (!plan.ok) return { ok: false, applied: false, ...plan, note: `打标失败：${plan.reason}` };
  const changed = { userMarked: 0, sessionMarked: 0, resumeDup: 0 };
  if (!apply) {
    return {
      ok: true,
      applied: false,
      dryRun: true,
      ...plan,
      changed,
      note: `dry-run：${plan.note} 加 ?apply=1 才会真正改写。`,
    };
  }
  try {
    const a = await queryFn(MARK_SQL.userMarked, []);
    changed.userMarked = Number(a?.rowCount ?? 0) || 0;
    const s = await queryFn(MARK_SQL.sessionMarked, []);
    changed.sessionMarked = Number(s?.rowCount ?? 0) || 0;
    if (plan.resumeIds.length) {
      const b = await queryFn(MARK_SQL.resumeDup, [plan.resumeIds]);
      changed.resumeDup = Number(b?.rowCount ?? 0) || 0;
    }
    return {
      ok: true,
      applied: true,
      dryRun: false,
      ...plan,
      changed,
      note: `已打标：用户级 ${changed.userMarked} 条、会话级 ${changed.sessionMarked} 条、blind_resume 重复 ${changed.resumeDup} 条（未删除任何数据）。`,
    };
  } catch (e) {
    return { ok: false, applied: false, ...plan, changed, note: `打标失败：${e?.message || e}` };
  }
}

/* ------------------------------------------------------------------ *
 * 五、汇总：给看板与发布验证共用的隔离自检                               *
 * ------------------------------------------------------------------ */

/** 分口径计数：RQ-157 验收「测试流量占比可查」 */
export const SCOPE_COUNT_SQL = `
  SELECT COUNT(*) FILTER (WHERE e.is_test = FALSE AND COALESCE(u.is_test, FALSE) = FALSE)::int AS real_cnt,
         COUNT(*) FILTER (WHERE e.is_test = TRUE  OR  COALESCE(u.is_test, FALSE) = TRUE )::int AS test_cnt
    FROM analytics_events e
    LEFT JOIN users u ON u.id = e.user_id`;

/** 「单用户单会话 blind_resume」分组计数（历史污染也在这里被看见） */
export const RESUME_DEDUPE_SQL = `
  SELECT COALESCE(e.user_id::text, NULLIF(e.payload->>'guestToken',''), 'anon') AS subject,
         NULLIF(e.payload->>'sessionId','') AS session_id,
         COUNT(*)::int AS count
    FROM analytics_events e
   WHERE e.event = 'blind_resume' AND e.is_test = FALSE
   GROUP BY 1, 2`;

/**
 * 隔离自检（RQ-157 验收「is_test=true 事件数 >0 且默认看板不可见」）。
 *
 * @param {object} o { scopeCounts, resumeRows, files }
 */
export function auditTestIsolation(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const sc = src.scopeCounts && typeof src.scopeCounts === 'object' ? src.scopeCounts : {};
  const testCount = Number.isFinite(Number(sc.test)) ? Number(sc.test) : 0;
  const realCount = Number.isFinite(Number(sc.real)) ? Number(sc.real) : 0;
  const dedupe = auditResumeDedupe(src.resumeRows || [], src.dedupeOpts || {});
  const scan = scanMissingTestFilter(src.files || []);

  const blockers = [];
  // 「一条测试都没有」比「测试没被排除」更可疑：说明打标从未执行
  if (testCount === 0) blockers.push('库内 is_test=true 事件数为 0，说明打标从未执行过，看板读数仍全部含压测流量');
  if (!dedupe.ok) blockers.push(`blind_resume 去重未生效：${dedupe.detail}`);
  if (!scan.ok) blockers.push(`${scan.offenders.length} 个读点未声明流量口径：${scan.offenders.map((x) => x.path).join('、')}`);

  return {
    ok: blockers.length === 0,
    scope: { real: realCount, test: testCount, testRatio: realCount + testCount > 0 ? Math.round((testCount / (realCount + testCount)) * 10000) / 100 : 0 },
    dedupe,
    scan,
    blockers,
    note: blockers.length === 0
      ? `测试流量 ${testCount} 条已默认排除，看板分母 ${realCount} 条。`
      : `隔离未生效：${blockers.join('；')}`,
  };
}

/**
 * 收集待扫描的源文件（可注入 fs，便于单测）。
 *
 * 只扫会写 SQL 的三个目录：`services` / `routes` / `scripts`。
 * 全量扫 `src/**` 会带进测试夹具与数据库驱动，既慢又会产生假阳性。
 *
 * @param {object} o { root, dirs, maxFiles, readFn, readdirFn, existsFn }
 * @returns {Array} [{path, text}]
 */
export function collectSourceFiles({ root = '', dirs = ['services', 'routes', 'scripts'], maxFiles = 400, readFn = null, readdirFn = null, joinFn = null } = {}) {
  if (!readFn || !readdirFn) return [];
  const join = joinFn || ((a, b) => `${a}/${b}`);
  const out = [];
  for (const d of dirs) {
    let names = [];
    try {
      names = readdirFn(join(root, d)) || [];
    } catch {
      continue;
    }
    for (const n of names) {
      if (out.length >= maxFiles) return out;
      if (!String(n).endsWith('.js')) continue;
      const p = join(join(root, d), n);
      let text = '';
      try {
        text = readFn(p, 'utf8');
      } catch {
        continue;
      }
      if (text) out.push({ path: `src/${d}/${n}`, text });
    }
  }
  return out;
}

/**
 * 从 DB 取一次完整的隔离自检读数（RQ-157 的唯一入口）。
 *
 * 三个读数刻意一起取：只看 `is_test` 计数会得出「已打标」，
 * 只看去重会得出「已收敛」，而「看板 SQL 有没有声明口径」才是决定指标干不干净的那一项。
 *
 * @param {object} o { queryFn, files }
 */
export async function isolationReport({ queryFn = null, files = [], dedupeOpts = {} } = {}) {
  if (!queryFn) return { ok: false, reason: '未提供 queryFn', ...auditTestIsolation({}) };
  try {
    const [sc, rs] = await Promise.all([queryFn(SCOPE_COUNT_SQL, []), queryFn(RESUME_DEDUPE_SQL, [])]);
    const scopeCounts = { real: Number(sc?.rows?.[0]?.real_cnt ?? 0) || 0, test: Number(sc?.rows?.[0]?.test_cnt ?? 0) || 0 };
    return {
      ok: true,
      ...auditTestIsolation({ scopeCounts, resumeRows: rs?.rows || [], files, dedupeOpts }),
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e), ...auditTestIsolation({}) };
  }
}

export default {
  isolationReport,
  collectSourceFiles,
  SCOPE_COUNT_SQL,
  RESUME_DEDUPE_SQL,
  TRAFFIC_SCOPES,
  DEFAULT_TRAFFIC_SCOPE,
  FULL_SCOPE_READERS,
  trafficScopeJoin,
  trafficScopeWhere,
  boardScopeOf,
  classifyIngest,
  scanMissingTestFilter,
  auditResumeDedupe,
  auditTestIsolation,
  MARK_SQL,
  pickDuplicateResumeIds,
  planHistoricalMarks,
  applyHistoricalMarks,
};
