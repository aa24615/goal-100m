import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EquityPoint } from '../types';
import { formatMoney, formatPct } from '../utils';

const C_CASH = '#7fd1cb'; // 资金账户（现金）
const C_HOLD = '#0d9488'; // 交易账户（持仓市值）
const C_LINE = '#0ea5a4'; // 收益曲线

export type EquityMetric = 'total' | 'profit' | 'returnPct';

export default function EquityChart({
  series,
  metric,
  initialCapital,
}: {
  series: EquityPoint[];
  metric: EquityMetric;
  initialCapital: number;
}) {
  const option = useMemo(() => {
    const dates = series.map((p) => p.date);
    const axis = {
      type: 'category' as const,
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#d9d9d9' } },
      axisLabel: {
        color: '#8c8c8c',
        // 分时标签形如「2026-10-21 01:10」取时间部分，日线标签形如「2026-10-21」取月日
        formatter: (v: string) => (v.includes(' ') ? v.split(' ')[1] : v.slice(5)),
      },
    };
    const valueAxis = {
      type: 'value' as const,
      scale: true,
      splitLine: { lineStyle: { color: '#f0f0f0' } },
      axisLabel: { color: '#8c8c8c' },
    };

    const tooltip = {
      trigger: 'axis' as const,
      formatter: (params: any) => {
        const i = params[0].dataIndex;
        const p = series[i];
        return [
          `<b>${p.date}</b>`,
          `总资产：¥${formatMoney(p.totalAssets)}`,
          `资金账户：¥${formatMoney(p.cash)}`,
          `交易账户：¥${formatMoney(p.marketValue)}`,
          `收益额：¥${formatMoney(p.profit)}`,
          `收益率：${formatPct(p.returnPct)}`,
        ].join('<br/>');
      },
    };

    if (metric === 'total') {
      return {
        animation: false,
        grid: { left: 68, right: 20, top: 34, bottom: 30 },
        tooltip,
        legend: { data: ['资金账户', '交易账户'], top: 0, textStyle: { color: '#8c8c8c' } },
        xAxis: axis,
        yAxis: { ...valueAxis, name: '元', nameTextStyle: { color: '#8c8c8c' } },
        series: [
          {
            name: '资金账户',
            type: 'line',
            stack: 'asset',
            data: series.map((p) => p.cash),
            showSymbol: false,
            lineStyle: { width: 1 },
            areaStyle: { color: C_CASH },
            itemStyle: { color: C_CASH },
          },
          {
            name: '交易账户',
            type: 'line',
            stack: 'asset',
            data: series.map((p) => p.marketValue),
            showSymbol: false,
            lineStyle: { width: 1 },
            areaStyle: { color: C_HOLD },
            itemStyle: { color: C_HOLD },
            markLine: {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: initialCapital }],
              lineStyle: { color: '#bfbfbf', type: 'dashed' },
              label: { formatter: '本金', color: '#8c8c8c', position: 'insideEndTop' },
            },
          },
        ],
      };
    }

    if (metric === 'profit') {
      return {
        animation: false,
        grid: { left: 68, right: 20, top: 20, bottom: 30 },
        tooltip,
        xAxis: axis,
        yAxis: { ...valueAxis, name: '元', nameTextStyle: { color: '#8c8c8c' } },
        series: [
          {
            name: '收益额',
            type: 'line',
            data: series.map((p) => p.profit),
            showSymbol: false,
            lineStyle: { color: C_LINE, width: 1.8 },
            itemStyle: { color: C_LINE },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(14,165,164,0.22)' },
                  { offset: 1, color: 'rgba(14,165,164,0)' },
                ],
              },
            },
            markLine: {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: 0 }],
              lineStyle: { color: '#bfbfbf', type: 'dashed' },
              label: { formatter: '盈亏线', color: '#8c8c8c', position: 'insideEndTop' },
            },
          },
        ],
      };
    }

    return {
      animation: false,
      grid: { left: 60, right: 20, top: 20, bottom: 30 },
      tooltip,
      xAxis: axis,
      yAxis: {
        ...valueAxis,
        name: '%',
        nameTextStyle: { color: '#8c8c8c' },
        axisLabel: { color: '#8c8c8c', formatter: '{value}%' },
      },
      series: [
        {
          name: '收益率',
          type: 'line',
          data: series.map((p) => p.returnPct),
          showSymbol: false,
          lineStyle: { color: C_LINE, width: 1.8 },
          itemStyle: { color: C_LINE },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(14,165,164,0.20)' },
                { offset: 1, color: 'rgba(14,165,164,0)' },
              ],
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: 0 }],
            lineStyle: { color: '#bfbfbf', type: 'dashed' },
            label: { formatter: '0%', color: '#8c8c8c', position: 'insideEndTop' },
          },
        },
      ],
    };
  }, [series, metric, initialCapital]);

  return <ReactECharts option={option} style={{ height: 320, width: '100%' }} notMerge />;
}
