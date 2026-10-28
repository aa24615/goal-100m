/**
 * 设备维度（RQ-115 / F-38）
 *
 * v8 把手机端可用性（RQ-103）判为「已上线」，v9 复核为**从未实测**：
 * `useIsMobile` 已上线，但没有任何一次来自移动端的真实会话。
 * 训练主场景（休市 / 通勤）大概率在手机上，可用性却从未被真实验证。
 *
 * 工程侧能做的两件事：
 *   1. 埋点带上设备维度——否则即使有移动端会话，也回答不了「手机端完成率是多少」；
 *   2. 给出一份可断言的移动端就绪清单，把「实测」变成可勾选的条目而不是口头结论。
 *
 * 纯函数模块，不读 UA 以外的任何信息（硬约束 4：不采集未脱敏身份信息）。
 */

export const DEVICES = ['mobile', 'tablet', 'desktop', 'unknown'];

/** 极简 UA 判定：只区分三类，不做浏览器指纹 */
export function deviceOf(userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  if (!ua) return 'unknown';
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet';
  if (/iphone|ipod|android|windows phone|blackberry|mobile/.test(ua)) return 'mobile';
  if (/macintosh|windows|x11|linux/.test(ua)) return 'desktop';
  return 'unknown';
}

/** 视角维度：竖屏 / 横屏（埋点只记方向，不记分辨率，避免指纹化） */
export function orientationOf(o) {
  const src = o && typeof o === 'object' ? o : {};
  const w = Number(src.width);
  const h = Number(src.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'unknown';
  return h >= w ? 'portrait' : 'landscape';
}

/** 给埋点 payload 补设备维度（不改变原有字段语义） */
export function withDevice(payload = {}, req = null) {
  const p = payload && typeof payload === 'object' ? { ...payload } : {};
  const ua = req?.headers?.['user-agent'];
  const dev = deviceOf(ua);
  if (dev !== 'unknown') p.device = dev;
  const ori = orientationOf({ width: p.screenWidth, height: p.screenHeight });
  if (ori !== 'unknown') p.orientation = ori;
  // 分辨率本身不入埋点：可用于指纹，且对回答「手机端能不能用」没有增量价值
  delete p.screenWidth;
  delete p.screenHeight;
  return p;
}

/** 移动端就绪清单：把「实测」变成可勾选的条目 */
export function mobileReadiness(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const items = [
    { key: 'portrait', label: '竖屏完整走完一局并出成绩卡', done: Boolean(src.portraitRun), required: true },
    { key: 'noHScroll', label: '关键页面无横向滚动', done: Boolean(src.noHorizontalScroll), required: true },
    { key: 'tapTarget', label: '主 CTA 触控区 ≥44px 且不误触', done: Boolean(src.tapTarget), required: true },
    { key: 'deviceTag', label: '埋点可区分设备（mobile / desktop）', done: Boolean(src.deviceTag), required: true },
    { key: 'guest', label: '免登录即可完成一局（RQ-108）', done: Boolean(src.guestRun), required: false },
  ];
  const missing = items.filter((i) => i.required && !i.done).map((i) => i.key);
  return {
    items,
    ready: missing.length === 0,
    missing,
    note:
      missing.length === 0
        ? '移动端就绪清单全部通过。'
        : `仍有 ${missing.length} 项未实测：${missing.join(' / ')}。组件级断言替代不了真机走查（v8 教训）。`,
  };
}
