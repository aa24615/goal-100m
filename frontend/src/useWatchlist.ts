import { useCallback, useEffect, useState } from 'react';
import api from './api';
import { useAuth } from './auth';

/**
 * 自选股：后端持久化为主，localStorage 仅作离线兜底与首屏加速。
 * 三个页面（行情中心 / 自选股 / 个股详情）共用同一份状态。
 */
const KEY = 'pt_watchlist';

function readLocal(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeLocal(arr: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

export function useWatchlist() {
  const { token } = useAuth();
  const [watch, setWatch] = useState<string[]>(readLocal);

  useEffect(() => {
    if (!token) {
      setWatch(readLocal());
      return;
    }
    api
      .get<string[]>('/watchlist')
      .then((r) => {
        setWatch(r.data || []);
        writeLocal(r.data || []);
      })
      .catch(() => setWatch(readLocal()));
  }, [token]);

  const add = useCallback(
    async (code: string) => {
      const arr = Array.from(new Set([...watch, code]));
      setWatch(arr);
      writeLocal(arr);
      try {
        await api.post('/watchlist', { code });
      } catch {
        /* 失败时保留本地结果，不至于打断操作 */
      }
    },
    [watch]
  );

  const remove = useCallback(
    async (code: string) => {
      const arr = watch.filter((c) => c !== code);
      setWatch(arr);
      writeLocal(arr);
      try {
        await api.delete(`/watchlist/${code}`);
      } catch {
        /* ignore */
      }
    },
    [watch]
  );

  const toggle = useCallback(
    (code: string) => (watch.includes(code) ? remove(code) : add(code)),
    [watch, add, remove]
  );

  const has = useCallback((code: string) => watch.includes(code), [watch]);

  return { watch, add, remove, toggle, has };
}
