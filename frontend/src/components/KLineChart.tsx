import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { DailyBar } from '../types';

// 日 K 线（F-01 / RQ-01）：此前系统每天在落库历史日线，用户却只能看当日分时。
// 涨跌沿用 A 股「红涨绿跌」。
const UP = '#e0584f';
const DOWN = '#2fa06a';

export default function KLineChart({
  bars,
  height = 300,
  /** 回放模式下高亮当前所在的 bar */
  cursorSeq,
  marks = [],
}: {
  bars: DailyBar[] | { seq: number; open: number; high: number; low: number; close: number }[];
  height?: number;
  cursorSeq?: number;
  marks?: { seq: number; label: string; side: 'BUY' | 'SELL' }[];
}) {
  const option = useMemo(() => {
    const labels = bars.map((b) => String(b.seq));
    // ECharts candlestick 数据顺序：open, close, low, high
    const k = bars.map((b) => [b.open, b.close, b.low, b.high]);
    const volumes = bars.map((b, i) => ({
      value: (b as DailyBar).volume ?? 0,
      itemStyle: { color: b.close >= b.open ? UP : DOWN },
      _i: i,
    }));

    const markArea =
      cursorSeq == null
        ? undefined
        : {
            silent: true,
            itemStyle: { color: 'rgba(14,165,164,0.10)' },
            data: [[{ xAxis: String(cursorSeq) }, { xAxis: String(cursorSeq) }]],
          };

    const markPoint = marks.length
      ? {
          symbolSize: 42,
          data: marks
            .filter((m) => labels.includes(String(m.seq)))
            .map((m) => ({
              name: m.label,
              coord: [String(m.seq), (bars.find((b) => b.seq === m.seq) as DailyBar)?.high ?? 0],
              value: m.side === 'BUY' ? 'B' : 'S',
              itemStyle: { color: m.side === 'BUY' ? UP : DOWN },
            })),
        }
      : undefined;

    return {
      animation: false,
      grid: [
        { left: 60, right: 24, top: 24, height: height * 0.62 },
        { left: 60, right: 24, top: height * 0.62 + 46, height: height * 0.2 },
      ],
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      xAxis: [
        { type: 'category', data: labels, gridIndex: 0, axisLabel: { color: '#8c8c8c' } },
        { type: 'category', data: labels, gridIndex: 1, axisLabel: { show: false } },
      ],
      yAxis: [
        { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLabel: { color: '#8c8c8c' } },
        { gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 4 },
      ],
      series: [
        {
          type: 'candlestick',
          data: k,
          xAxisIndex: 0,
          yAxisIndex: 0,
          itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
          markArea,
          markPoint,
        },
        { type: 'bar', data: volumes, xAxisIndex: 1, yAxisIndex: 1 },
      ],
    };
  }, [bars, cursorSeq, marks, height]);

  return <ReactECharts option={option} style={{ height }} notMerge />;
}
