/**
 * RQ-203 差异化叙事前置：三件套（可核对 / 可信度 / 保留期）曝光守护。
 *
 * v18 要求「注册页 / 训练页可见三件套声明」。此前首访入口讲了「真实行情 + 模拟撮合」
 * 与「保留期」，但「可核对」「可信度」这两件差异化能力没有在首访入口明确说出来——
 * 而它们恰恰是竞品全无的信任壁垒（A′ / B′）。本服务提供单一事实来源：
 *   ① 定义三件套的术语锚点（可被前端 constants 复用，防前后端漂移）；
 *   ② 扫描任意一组对外文案（落地页 / 访客帮助 / README），判定三件套是否都曝光；
 *   ③ 给出一致性结论，供单测与发布前校验复用。
 *
 * 纯函数 + 字符串扫描，无 DB、无 fs，便于无环境单测。
 */

/**
 * 三件套定义：key / 标题 / 必须出现的术语锚点（命中任一即视为该件已曝光）。
 * 锚点刻意给多个同义表述：A 股用户说「逐笔」会与 L2 盘口混淆，所以用「可核对 / 自行重算」
 * 等更稳的措辞兜底；可信度用「样本不足」也能命中，因为那正是 B′ 的产品语言。
 */
export const DIFFERENTIATION_PIECES = [
  {
    key: 'checkable',
    title: '结算可核对',
    anchorTerms: ['可核对', '逐笔', '自检', '重算', '自行重算'],
  },
  {
    key: 'confidence',
    title: '可信度护栏',
    anchorTerms: ['可信度', '置信区间', '误差带', 't 值', '样本不足'],
  },
  {
    key: 'retention',
    title: '保留期承诺',
    anchorTerms: ['保留期', '长期保留', '过期不找回', '数据不会消失'],
  },
];

/**
 * 扫描一组对外文案，判定三件套的曝光情况（纯函数）。
 *
 * @param {object} o
 * @param {Array<{name?:string, text:string}>} [o.surfaces] 待扫描的文案面
 * @param {string} [o.combined] 也可直接传入合并后的全文（优先级低于 surfaces）
 * @returns {{
 *   pieces: Array<{key:string,title:string,exposed:boolean,terms:string[],missingTerms:string[],firstSurface:string|null}>,
 *   exposedCount:number, missing:string[], allExposed:boolean, consistent:boolean
 * }}
 */
export function auditThreePieceExposure(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const surfaces = Array.isArray(src.surfaces) ? src.surfaces : [];
  const combined = String(src.combined ?? '').trim();
  const corpus = combined || surfaces.map((s) => String(s?.text ?? '')).join('\n');

  const pieces = DIFFERENTIATION_PIECES.map((p) => {
    const hits = p.anchorTerms.filter((t) => corpus.includes(t));
    const firstSurface = surfaces.find((s) => p.anchorTerms.some((t) => String(s?.text ?? '').includes(t)));
    return {
      key: p.key,
      title: p.title,
      exposed: hits.length > 0,
      terms: hits,
      missingTerms: p.anchorTerms.filter((t) => !hits.includes(t)),
      firstSurface: firstSurface ? String(firstSurface.name ?? '') : null,
    };
  });

  const missing = pieces.filter((p) => !p.exposed).map((p) => p.key);
  const exposedCount = pieces.filter((p) => p.exposed).length;
  return {
    pieces,
    exposedCount,
    missing,
    allExposed: missing.length === 0,
    /**
     * 一致性：三件套要么一起出现，要么一起缺失；只出现两件视为口径不一致
     * （说明有一件被刻意藏了，恰恰是信任壁垒最该说清的地方）。
     */
    consistent: exposedCount === 0 || exposedCount === DIFFERENTIATION_PIECES.length,
  };
}
