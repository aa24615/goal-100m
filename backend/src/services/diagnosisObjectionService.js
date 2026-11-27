/**
 * 拒绝归类（RQ-226 / M48 / I-2 / F-118 伴生）
 *
 * v37 的核心判断：竞品都在做「正向画像」——熊猫 K 线给能力画像 + 问题 TOP5、
 * TradingSim 给 expectancy/average R、绕云给盈亏比。没有一家做「负向护栏」，
 * 更没有一家允许用户说「我不同意这个诊断」。
 *
 * I-2 的空位是「你可以自己重算、可以不同意」：
 *   - 竞品给「你必须信我」的画像；
 *   - 我方给「这是口径、这是证据、你可以不同意，而且我留痕」。
 *
 * 本服务实现「拒绝归类」的**纯函数内核**：
 *   1. 把系统诊断项（结论/画像，非事实）抽取成「可不同意」清单；
 *   2. 用户标记不同意 → 生成结构化留痕记录（含理由、时间、归属、证据指纹）；
 *   3. 留痕去重（同一人 + 同一会话 + 同一诊断项只留一条，可改理由）；
 *   4. 归属隔离（游客 token / 注册 userId 绝不串号——v10 identityOf 踩过 Number(null)=0）；
 *   5. 汇总对账（争议率、按诊断项分布），供「诊断是否被集中质疑」自检。
 *
 * 设计约束（沿用既有踩坑教训）：
 *   - **纯函数**：不碰数据库。行数据由调用方注入，服务本身不发请求。
 *   - **null 与 0 严格区分**：`Number(null)===0` 会把「无归属」算成 userId=0（外键 23503）。
 *   - **显式判空**：`function f({a}={})` 兜不住 `f(null)`，一律 `o && typeof o === 'object'`。
 *   - **不删除原诊断**：标记不同意后原诊断仍在，只叠加 `objected:true` 与留痕引用——
 *     「你可以不同意我」不等于「我把说过的抹掉」，后者才是不诚实。
 */

/** 可标记「不同意」的诊断项目录：只收**结论/画像**类，事实类（成本/行为）不可标记 */
export const DIAGNOSIS_CATALOG = [
  {
    key: 'verdict',
    label: '综合结论',
    source: 'checkupService.buildCheckup.verdict',
    kind: 'inference',
    hint: '基于样本给出的方向性判断，样本不足时本就不给——若出现即可质疑。',
  },
  {
    key: 'worstHabit',
    label: '最坏习惯诊断',
    source: 'checkupService.buildCheckup.worstHabit',
    kind: 'inference',
    hint: '「你最常犯的错」是归类判断，允许你用真实场景反驳。',
  },
  {
    key: 'expectancy',
    label: '期望值结论',
    source: 'checkupService.buildCheckup.expectancy',
    kind: 'inference',
    hint: '期望值为统计推断，带误差带；可不同意其适用性。',
  },
  {
    key: 'discipline',
    label: '纪律执行率评价',
    source: 'checkupService.buildCheckup.discipline',
    kind: 'inference',
    hint: '行为计数本身是事实，但「好坏」评价可不同意。',
  },
  {
    key: 'tier',
    label: '可信度档位',
    source: 'checkupService.buildCheckup.tier',
    kind: 'inference',
    hint: '档位由笔数机械决定，通常不争议，但保留申诉口。',
  },
];

const CATALOG_KEYS = new Set(DIAGNOSIS_CATALOG.map((d) => d.key));

/** 理由长度上限：与项目 textSanitize 口径一致，防止用超长文本淹没留痕表 */
export const REASON_MAX_LEN = 300;
/** 单会话可标记的诊断项数量上限（=目录大小），防御性常数 */
export const MAX_OBJECTIONS_PER_SESSION = DIAGNOSIS_CATALOG.length;

function textOf(v) {
  return String(v ?? '').trim();
}

/**
 * 归一化诊断 key：大小写/连字符不敏感，但**返回目录里的规范 key**。
 *
 * 注意：不能先 toLowerCase 再直接查 CATALOG_KEYS——目录里 worstHabit 是驼峰，
 * 小写化后 worsthabit 永远匹配不上（v38 自测抓到的真实 bug）。必须先建小写索引。
 */
const CATALOG_KEY_BY_LOWER = new Map(DIAGNOSIS_CATALOG.map((d) => [d.key.toLowerCase(), d.key]));

export function normalizeDiagnosisKey(raw) {
  const k = textOf(raw).toLowerCase();
  return CATALOG_KEY_BY_LOWER.get(k) || null;
}

/**
 * 从体检单抽取「可不同意」的诊断项清单（纯函数）。
 *
 * 只抽结论/画像类，事实类（成本/行为流水）不进清单——
 * 事实是可以自己重算的（RQ-225），不存在「不同意事实」的语义。
 *
 * @param {object} checkup checkupService.buildCheckup 的结果
 * @returns {Array<{key,label,text,kind,available}>}
 */
export function extractDiagnosableItems(checkup) {
  const c = checkup && typeof checkup === 'object' ? checkup : {};
  const out = [];
  for (const d of DIAGNOSIS_CATALOG) {
    let text = null;
    if (d.key === 'verdict') text = c.verdict?.summary || c.verdict?.text || null;
    else if (d.key === 'worstHabit') text = c.worstHabit?.title || c.worstHabit?.label || null;
    else if (d.key === 'expectancy') {
      const hasValue = c.expectancyR?.value != null;
      text = c.expectancy?.hint || hasValue ? `${c.expectancy?.hint || ''}${hasValue ? ` 当前 ${c.expectancyR.value}R` : ''}`.trim() : null;
    }
    else if (d.key === 'discipline') text = c.discipline?.hint || null;
    else if (d.key === 'tier') text = c.tierLabel || c.tier?.label || null;
    out.push({
      key: d.key,
      label: d.label,
      kind: d.kind,
      text: textOf(text) || null,
      available: Boolean(textOf(text)),
      hint: d.hint,
    });
  }
  return out;
}

/**
 * 校验一条「不同意」标记是否合法。
 *
 * @returns {{ok:boolean, reason?:string, key?:string}}
 */
export function validateObjection(raw, ctx = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const key = normalizeDiagnosisKey(r.diagnosisKey);
  if (!key) return { ok: false, reason: '未知诊断项，不能标记不同意' };
  const reason = textOf(r.reason);
  if (!reason) return { ok: false, reason: '请说明不同意的理由（至少填写一句话）' };
  if (reason.length > REASON_MAX_LEN) return { ok: false, reason: `理由超过 ${REASON_MAX_LEN} 字上限` };
  const cx = ctx && typeof ctx === 'object' ? ctx : {};
  if (cx.availableKeys && Array.isArray(cx.availableKeys) && !cx.availableKeys.includes(key)) {
    return { ok: false, reason: '该诊断项在当前样本下未生成，无可标记内容' };
  }
  return { ok: true, key };
}

/**
 * 归属指纹：把 userId / guestToken 归一为稳定的 ownerKey，绝不把 null 算成 0。
 * 与 guestService.safeUserId 口径一致：只有有限正整数的 userId 才算注册用户。
 */
export function ownerKeyOf(identity = {}) {
  const id = identity && typeof identity === 'object' ? identity : {};
  const uid = id.userId;
  const numericUid = Number(uid);
  if (uid != null && uid !== '' && Number.isInteger(numericUid) && numericUid > 0) {
    return `u:${numericUid}`;
  }
  const token = textOf(id.guestToken);
  if (token) return `g:${token}`;
  return null;
}

/**
 * 构建一条留痕记录（纯函数）。
 *
 * @param {object} raw   {diagnosisKey, reason, sessionId}
 * @param {object} ctx   {userId, guestToken, now, evidence}
 * @returns {object|null} 非法时返回 null（调用方据此回 400）
 */
export function buildObjectionRecord(raw, ctx = {}) {
  const v = validateObjection(raw, ctx);
  if (!v.ok) return null;
  const r = raw && typeof raw === 'object' ? raw : {};
  const cx = ctx && typeof ctx === 'object' ? ctx : {};
  const ownerKey = ownerKeyOf(cx);
  if (!ownerKey) return null; // 无归属不入库，避免孤儿行

  const sidRaw = r.sessionId;
  const sidNum = Number(sidRaw);
  const sessionId = sidRaw != null && sidRaw !== '' && Number.isInteger(sidNum) && sidNum > 0 ? sidNum : null;
  const now = cx.now instanceof Date ? cx.now : new Date();
  const ev = cx.evidence && typeof cx.evidence === 'object' ? cx.evidence : {};

  return {
    ownerKey,
    userId: ownerKey.startsWith('u:') ? Number(ownerKey.slice(2)) : null,
    guestToken: ownerKey.startsWith('g:') ? ownerKey.slice(2) : null,
    sessionId,
    diagnosisKey: v.key,
    reason: textOf(r.reason).slice(0, REASON_MAX_LEN),
    createdAt: now.toISOString(),
    // 证据指纹：留痕时把当时的诊断摘要一起存，日后可核对「当时到底给了什么结论」
    evidenceText: textOf(ev.text) || null,
    sampleSize: Number.isFinite(Number(ev.sampleSize)) && Number(ev.sampleSize) >= 0 ? Math.floor(Number(ev.sampleSize)) : null,
  };
}

/**
 * 留痕去重：同一 ownerKey + sessionId + diagnosisKey 只留一条（后写覆盖前写）。
 * sessionId 为空时用 null 归组（游客未开局场景），仍严格按 ownerKey 隔离。
 */
export function dedupeObjections(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  for (const rawRow of list) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    // DB 原始行没有 ownerKey / diagnosisKey / createdAt 这些虚拟/驼峰字段，
    // 只有 user_id / guest_token / diagnosis_key / created_at 蛇形列——
    // 必须归一化，否则「记录可查」在真实链路上永远返回空（v38 冒烟抓出）。
    const row = { ...rawRow };
    let ok = textOf(row.ownerKey);
    if (!ok) {
      const uid = row.user_id ?? row.userId;
      const numericUid = Number(uid);
      if (uid != null && uid !== '' && Number.isInteger(numericUid) && numericUid > 0) ok = `u:${numericUid}`;
      else {
        const g = textOf(row.guest_token ?? row.guestToken);
        ok = g ? `g:${g}` : '';
      }
    }
    if (!ok) continue;
    row.ownerKey = ok;
    if (!textOf(row.diagnosisKey)) row.diagnosisKey = textOf(row.diagnosis_key);
    if (!row.createdAt) row.createdAt = row.created_at ? String(row.created_at) : '';
    const sid = row.sessionId ?? row.session_id;
    const sidKey = sid == null ? 'none' : String(sid);
    const key = `${ok}|${sidKey}|${textOf(row.diagnosisKey)}`;
    const prev = map.get(key);
    if (!prev || String(row.createdAt || '') >= String(prev.createdAt || '')) map.set(key, row);
  }
  return [...map.values()];
}

/**
 * 把留痕应用到诊断视图：每项叠加 objected 状态，但**保留原诊断文本**。
 * 这是「你可以不同意我」与「我抹掉说过的」的分界线。
 */
export function applyObjections(items, objections = []) {
  const list = Array.isArray(items) ? items : [];
  const objs = dedupeObjections(objections);
  const keySet = new Set(objs.map((o) => o.diagnosisKey));
  const latest = new Map();
  for (const o of objs) latest.set(o.diagnosisKey, o);
  return list.map((it) => {
    const item = it && typeof it === 'object' ? it : {};
    const objection = keySet.has(item.key) ? latest.get(item.key) : null;
    return {
      ...item,
      objected: Boolean(objection),
      objectionReason: objection?.reason || null,
      objectedAt: objection?.createdAt || null,
    };
  });
}

/**
 * 汇总对账：争议率、按诊断项分布、有无孤儿归属。
 *
 * @param {Array} rows 留痕行
 * @param {object} o {totalDiagnoses} 本批诊断项总数（用于算争议率）
 */
export function summarizeObjections(rows = [], o = {}) {
  const list = dedupeObjections(rows);
  const opt = o && typeof o === 'object' ? o : {};
  const byKey = {};
  for (const d of DIAGNOSIS_CATALOG) byKey[d.key] = 0;
  let orphan = 0;
  for (const r of list) {
    if (Object.prototype.hasOwnProperty.call(byKey, r.diagnosisKey)) byKey[r.diagnosisKey] += 1;
    if (!textOf(r.ownerKey)) orphan += 1;
  }
  const total = list.length;
  const totalDiagnoses = Number(opt.totalDiagnoses);
  const denom = Number.isFinite(totalDiagnoses) && totalDiagnoses > 0 ? totalDiagnoses : null;
  return {
    total,
    byKey,
    orphan,
    disputedKeys: Object.keys(byKey).filter((k) => byKey[k] > 0),
    mostDisputed: Object.entries(byKey).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    disputeRate: denom == null ? null : Math.round((total / denom) * 10000) / 100,
    ok: orphan === 0,
    note: '不同意留痕不删除原诊断；争议率高说明诊断口径需要复核，而不是用户需要教育。',
  };
}

/** 归属过滤子句：与 guestService.ownerClause 同口径，占位符从 startIndex 起 */
export function objectionOwnerClause(identity = {}, startIndex = 1) {
  const key = ownerKeyOf(identity);
  if (!key) return { sql: 'FALSE', params: [], ownerKey: null };
  const i = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 1;
  if (key.startsWith('u:')) {
    return { sql: `user_id = $${i}`, params: [Number(key.slice(2))], ownerKey: key };
  }
  return { sql: `guest_token = $${i}`, params: [key.slice(2)], ownerKey: key };
}

/** 留痕表 SQL 片段（迁移 0022 使用，供自检脚本核对列名） */
export const OBJECTION_SQL = {
  table: 'diagnosis_objections',
  columns: ['id', 'user_id', 'guest_token', 'session_id', 'diagnosis_key', 'reason', 'evidence_text', 'sample_size', 'created_at'],
  insert:
    'INSERT INTO diagnosis_objections (user_id, guest_token, session_id, diagnosis_key, reason, evidence_text, sample_size) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7)',
  unique: 'uq_diagnosis_objections_owner_session_key',
  // ON CONFLICT 必须用列名推断（unique 是索引名而非约束名，且 NULLS NOT DISTINCT 索引可被正确推断）
  conflictColumns: 'user_id, guest_token, session_id, diagnosis_key',
};
