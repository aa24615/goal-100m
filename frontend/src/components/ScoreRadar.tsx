import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

// RQ-24：能力雷达（择时 / 选股 / 风控 / 纪律），给新手一个明确的能力坐标。
export default function ScoreRadar({
  dimensions,
  overall,
  height = 280,
}: {
  dimensions: { label: string; score: number }[];
  overall?: number;
  height?: number;
}) {
  const option = useMemo(
    () => ({
      animation: false,
      tooltip: {},
      radar: {
        indicator: dimensions.map((d) => ({ name: d.label, max: 100 })),
        radius: '68%',
        axisName: { color: '#595959', fontSize: 12 },
        splitLine: { lineStyle: { color: '#e8e8e8' } },
        splitArea: { areaStyle: { color: ['#fff', '#fafafa'] } },
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              value: dimensions.map((d) => d.score),
              name: '能力值',
              areaStyle: { color: 'rgba(14,165,164,0.25)' },
              lineStyle: { color: '#0ea5a4' },
              itemStyle: { color: '#0d9488' },
              label: { show: true, formatter: (p: any) => String(p.value), color: '#0d9488' },
            },
          ],
        },
      ],
    }),
    [dimensions]
  );

  return (
    <div>
      <ReactECharts option={option} style={{ height }} notMerge />
      {overall !== undefined && (
        <div style={{ textAlign: 'center', color: '#8c8c8c', fontSize: 12 }}>
          综合能力 <b style={{ color: '#0d9488', fontSize: 16 }}>{overall}</b> / 100
        </div>
      )}
    </div>
  );
}
