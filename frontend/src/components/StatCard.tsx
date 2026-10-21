import React from 'react';
import { Card, Statistic } from 'antd';

interface Props {
  title: React.ReactNode;
  value: number | string;
  precision?: number;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  // 数值颜色（如涨红跌绿）；不传则走默认色
  valueColor?: string;
  valueStyle?: React.CSSProperties;
  cardTitle?: React.ReactNode;
  size?: 'default' | 'small';
  style?: React.CSSProperties;
}

// 统一的统计卡片：行情中心“四个统计高度没对齐”问题（需求 18）的根因是
// 每张卡片内联结构不一；收敛到本组件后，卡片结构与高度天然一致。
export default function StatCard({
  title,
  value,
  precision,
  prefix,
  suffix,
  valueColor,
  valueStyle,
  cardTitle,
  size = 'default',
  style,
}: Props) {
  return (
    <Card style={{ height: '100%', ...style }} size={size} title={cardTitle}>
      <Statistic
        title={title}
        value={value}
        precision={precision}
        prefix={prefix}
        suffix={suffix}
        valueStyle={{ fontWeight: 700, ...(valueColor ? { color: valueColor } : {}), ...valueStyle }}
      />
    </Card>
  );
}
