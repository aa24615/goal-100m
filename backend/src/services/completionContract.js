/**
 * 「完成」口径契约（RQ-109 / F-32）
 *
 * v9 实地复核发现产品里存在**三个互相矛盾的「完成」口径**：
 *   ① 引导卡片写「提交第一次判断就完成了」；
 *   ② 会话的 FINISHED 需要走完 60 根；
 *   ③ 北极星「首训完成率」算的是「首次决策」。
 * 用户不知道自己到底做完了没有，做完了也没有结算与成绩（F-32）。
 *
 * 契约：**完成 = 结算并出成绩卡**（会话 FINISHED 且 score 非空）。
 * 本文件是这条定义的唯一来源，前端文案、后端状态判定、北极星口径三处共用，
 * 并配一组自测守护（assertCompletionCopy）防止文案再次漂移到旧口径。
 */

export const COMPLETION = {
  version: 'v9',
  /** 一句话定义：三处必须一字不差地表达这个意思 */
  definition: '完成 = 结算并出成绩卡',
  sessionStatus: 'FINISHED',
  requiresScore: true,
  uiCopy: {
    card: '走到最后一根并结算，这一局才算完成，会生成一张成绩卡。',
    done: '这一局已完成，成绩卡已生成。',
    notDone: '这一局还没结算，继续走到最后一根即可出成绩卡。',
    cta: '走完这一局，拿成绩卡',
  },
  /** 旧口径的黑名单：这些说法一旦重现立即失败（守护口径不漂移） */
  forbiddenPhrases: [
    '提交第一次判断就完成了',
    '判断完就完成',
    '只要判断一次',
  ],
  /** 允许但必须改写为「决策 ≠ 完成」的模糊表述 */
  mustNotImplyDone: ['提交第一次判断'],
};

/** 判定会话是否已完成（结算并出成绩卡） */
export function isCompleted(session) {
  const s = session && typeof session === 'object' ? session : {};
  if (String(s.status || '').toUpperCase() !== COMPLETION.sessionStatus) return false;
  if (s.finishedAt == null && s.finished_at == null) return false;
  if (COMPLETION.requiresScore) {
    const sc = s.score ?? null;
    return Boolean(sc) && typeof sc === 'object';
  }
  return true;
}

/** 北极星口径：完成过至少一次（结算出成绩卡）的用户数占比 */
export function completionRate(completedUsers, registeredUsers) {
  const denom = Math.max(0, Number(registeredUsers) || 0);
  const numer = Math.min(Math.max(0, Number(completedUsers) || 0), denom);
  return {
    value: denom > 0 ? Math.round((numer / denom) * 10000) / 100 : null,
    numerator: numer,
    denominator: denom,
    readable: denom > 0,
    metric: '首训完成率',
    definition: COMPLETION.definition,
  };
}

/**
 * 文案守护：给定若干条页面/接口文案，返回违反契约的条目。
 * 供单测与 CI 使用——「已上线但口径漂移」是 F-32 的复发路径。
 */
export function assertCompletionCopy(texts = []) {
  const list = Array.isArray(texts) ? texts.map(String) : [];
  const violations = [];
  for (const t of list) {
    for (const bad of COMPLETION.forbiddenPhrases) {
      if (t.includes(bad)) violations.push({ text: t, phrase: bad, level: 'forbidden' });
    }
    for (const ambiguous of COMPLETION.mustNotImplyDone) {
      // 出现「提交第一次判断」却没有紧跟「≠ 完成」的解释，即视为可能误导
      if (t.includes(ambiguous) && !t.includes('完成') && !t.includes('成绩卡')) {
        violations.push({ text: t, phrase: ambiguous, level: 'ambiguous' });
      }
    }
  }
  return { ok: violations.length === 0, violations, definition: COMPLETION.definition };
}
