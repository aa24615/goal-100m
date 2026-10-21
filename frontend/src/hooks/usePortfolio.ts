import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import type { Portfolio as PF } from '../types';

// 持仓数据层：封装 /portfolio 的拉取与重新加载。
export function usePortfolio() {
  const [data, setData] = useState<PF | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    return api
      .get<PF>('/portfolio')
      .then((r) => setData(r.data))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, reload };
}
