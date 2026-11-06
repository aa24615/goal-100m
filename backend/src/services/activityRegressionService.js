/**
 * RQ-208 活动回归守护：防止「连自测开关都停了」。
 *
 * v18 实测：最后埋点距今约 71h，连自测都停了——即便挂上门也没有「屋内有人」信号。
 * 验收标准（逐条对应）：
 *   ① 每周 ≥ 3 条 blind_start 且非自测号；
 *   ② 最后事件距今 < 12h（周均）。
 *
 * 纯函数，便于单测与定时任务（cron / 周报）调用；取数在调用方，本文件只判定。
 */

/** 活动回归判据（验收标准逐条对应） */
export const ACTIVITY_RULES = {
  windowDays: 7,
  minBlindStart: 3, // 每周至少 3 条 blind_start
  requireNonTest: true, // 且须非自测号
  maxStalenessHours: 12, // 最后事件距今上限（小时）
};

/**
 * 评估活动是否回归（纯函数）。
 *
 * @param {object} o
 * @param {number} [o.blindStartCount]   窗口内 blind_start 条数
 * @param {number} [o.nonTestCount]      其中非自测的条数
 * @param {number} [o.lastEventAgeHours] 最后一条事件的年龄（小时）；null = 时间不可解析
 * @param {number} [o.windowDays]
 * @returns {{
 *   ok:boolean, rules:object, windowDays:number, blindStart:number, nonTest:number,
 *   lastEventAgeHours:number|null, reasons:Array<{code:string, detail:string}>, verdict:string
 * }}
 */
export function assessActivityRegression(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const rules = ACTIVITY_RULES;
  const windowDays = Math.max(1, Number(src.windowDays) || rules.windowDays);

  // 数值一律先判 null/空串再 Number：v10 identityOf 的 `Number(null)===0` 教训
  const blindStart = Math.max(0, Number(src.blindStartCount) || 0);
  const nonTest = Math.max(0, Number(src.nonTestCount) || 0);
  const age = src.lastEventAgeHours == null ? null : Math.max(0, Number(src.lastEventAgeHours));

  const reasons = [];

  const enoughVolume = blindStart >= rules.minBlindStart;
  if (!enoughVolume) {
    reasons.push({ code: 'LOW_VOLUME', detail: `blind_start ${blindStart} 条 < ${rules.minBlindStart} 条/周` });
  }

  // 非自测兜底：验收要求「非自测号」——全是非自测也不行，得先有量
  const mostlyNonTest = rules.requireNonTest ? nonTest >= rules.minBlindStart : true;
  if (rules.requireNonTest && !mostlyNonTest) {
    reasons.push({ code: 'TEST_DOMINATED', detail: `非自测 blind_start ${nonTest} 条 < ${rules.minBlindStart} 条` });
  }

  let freshEnough = true;
  if (age == null) {
    reasons.push({ code: 'NO_EVENT', detail: '窗口内无任何事件（或时间不可解析）' });
    freshEnough = false;
  } else if (age > rules.maxStalenessHours) {
    freshEnough = false;
    reasons.push({ code: 'STALE', detail: `最后事件距今 ${age}h > ${rules.maxStalenessHours}h` });
  }

  const ok = reasons.length === 0;
  return {
    ok,
    rules,
    windowDays,
    blindStart,
    nonTest,
    lastEventAgeHours: age,
    reasons,
    verdict: ok
      ? '活动正常：每周有非自测训练发生且信号新鲜。'
      : `活动回归风险：${reasons.map((r) => r.detail).join('；')}`,
  };
}
