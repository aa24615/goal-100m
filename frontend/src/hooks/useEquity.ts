import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import type { EquityResponse } from '../types';

// 资产曲线数据层：封装 /equity 拉取，并在日级点数不足（开户当天）时
// 自动回退到今日分时粒度，保证曲线立即可用。
export function useEquity(days: number) {
  const [equity, setEquity] = useState<EquityResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<EquityResponse>('/equity', { params: { days } });
      if (r.data.series.length < 3) {
        const m = await api.get<EquityResponse>('/equity', { params: { days: 1, gran: 'minute' } });
        setEquity(m.data.series.length >= 2 ? m.data : r.data);
      } else {
        setEquity(r.data);
      }
    } catch {
      /* 曲线加载失败不阻塞页面其余部分 */
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { equity, loading, reload };
}
