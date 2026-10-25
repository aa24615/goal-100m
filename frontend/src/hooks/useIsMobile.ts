/**
 * 视口断点 Hook（RQ-84 手机端训练）
 *
 * 训练的主场景（休市、通勤、碎片时间）大概率在手机上，而竞品（绕云 / 爆竹 / DXK / 福福）
 * 全是手机端。桌面端产品在手机上等于不存在，因此手机至少要达到「可用」。
 *
 * 用 matchMedia 而不是读 window.innerWidth：后者需要监听 resize 并自己算断点，
 * 前者由浏览器在跨越断点时精确回调，且 SSR / jsdom 下有稳定降级。
 */

import { useEffect, useState } from 'react';

/** 与 index.css 中 .blind-mobile 的媒体查询保持一致 */
export const MOBILE_BREAKPOINT = 768;

function query(breakpoint: number) {
  return `(max-width: ${breakpoint}px)`;
}

export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT) {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';

  const [isMobile, setIsMobile] = useState<boolean>(() => (supported ? window.matchMedia(query(breakpoint)).matches : false));

  useEffect(() => {
    if (!supported) return undefined;
    const mq = window.matchMedia(query(breakpoint));
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);

    // Safari < 14 只有已废弃的 addListener，两条路径都要留
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [breakpoint, supported]);

  return isMobile;
}

export default useIsMobile;
