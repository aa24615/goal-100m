import { useEffect, useMemo, useState } from 'react';
import { subscribe } from '../ws';
import api from '../api';
import type { StockQuote, MarketSummary } from '../types';

// 行情中心数据层：仅负责“订阅实时行情 + 拉取大盘汇总”，UI 筛选/搜索留在页面里。
export function useMarket() {
  const [quotes, setQuotes] = useState<StockQuote[]>([]);
  // 大盘汇总用后端的市值加权指数（等权平均价在真实全市场数据下没有指数意义）
  const [summary, setSummary] = useState<MarketSummary | null>(null);

  useEffect(() => subscribe(setQuotes), []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<MarketSummary>('/market/summary')
        .then((r) => {
          if (alive) setSummary(r.data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const sectors = useMemo(
    () => ['全部', ...Array.from(new Set(quotes.map((q) => q.sector)))],
    [quotes]
  );

  // 接口未就绪时的兜底：用当前可见报价做等权派生，保证卡片不会空着
  const fallback = useMemo<MarketSummary>(() => {
    let up = 0;
    let down = 0;
    let flat = 0;
    let idx = 0;
    let base = 0;
    for (const q of quotes) {
      if (q.change > 0) up += 1;
      else if (q.change < 0) down += 1;
      else flat += 1;
      idx += q.price;
      base += q.prevClose;
    }
    const total = quotes.length || 1;
    return {
      up,
      down,
      flat,
      total: quotes.length,
      indexValue: idx / total,
      indexPct: base ? ((idx - base) / base) * 100 : 0,
    };
  }, [quotes]);

  return { quotes, sectors, summary: summary ?? fallback };
}
