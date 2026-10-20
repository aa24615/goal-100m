import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { StockDetail } from '../types';

export default function StockChart({ detail }: { detail: StockDetail }) {
  const option = useMemo(() => {
    const data = detail.history.map((h) => [h.t, h.p]);
    const up = detail.price >= detail.prevClose;
    const lineColor = up ? '#e0584f' : '#2fa06a';
    const areaTop = up ? 'rgba(224,88,79,0.20)' : 'rgba(47,160,106,0.20)';
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 20, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = params[0];
          return `${new Date(p.value[0]).toLocaleTimeString()}<br/>价格：${p.value[1].toFixed(2)}`;
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: '#d9d9d9' } },
        axisLabel: { color: '#8c8c8c' },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitLine: { lineStyle: { color: '#f0f0f0' } },
        axisLabel: { color: '#8c8c8c' },
      },
      series: [
        {
          type: 'line',
          data,
          showSymbol: false,
          smooth: false,
          lineStyle: { color: lineColor, width: 1.5 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: areaTop },
                { offset: 1, color: 'rgba(255,255,255,0)' },
              ],
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: detail.prevClose }],
            lineStyle: { color: '#bfbfbf', type: 'dashed' },
            label: { formatter: '昨收', color: '#8c8c8c', position: 'end' },
          },
        },
      ],
    };
  }, [detail]);

  return <ReactECharts option={option} style={{ height: 360, width: '100%' }} notMerge />;
}
