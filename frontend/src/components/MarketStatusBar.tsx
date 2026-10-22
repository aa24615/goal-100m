import React from 'react';
import { Tag, Space, Tooltip } from 'antd';
import { FieldTimeOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';

// RQ-27：交易日状态不可见时，休市期间价格不动会让用户误以为系统卡死。
const PHASE_TEXT: Record<string, string> = {
  TRADING: '交易中',
  BREAK: '休市',
  CLOSED: '已收盘',
};

export default function MarketStatusBar({
  status,
  // 每个 tick 的毫秒数，用于估算剩余时间
  tickMinutes,
}: {
  status: {
    tradeSeq: number;
    tradeDate: string;
    phase: 'TRADING' | 'BREAK' | 'CLOSED';
    sessionTick: number;
    sessionTicks: number;
    ticksToClose: number;
    inWindow: boolean;
    realClock: boolean;
  };
  tickMinutes?: number;
}) {
  const open = status.phase === 'TRADING' && status.inWindow;
  const color = open ? 'green' : 'default';
  const perTick = tickMinutes ?? 2;
  const remainMin = Math.max(0, Math.ceil((status.ticksToClose * perTick) / 60));

  const phaseText = PHASE_TEXT[status.phase] || status.phase;
  // 压缩模式下给出 tick 倒计时；真实时钟模式按自然时段开市，无需倒计时
  const schedule = open
    ? status.realClock
      ? ' · 交易时段 9:30-11:30 / 13:00-15:00'
      : ` · 距收盘约 ${status.ticksToClose} 个 tick（≈${remainMin} 分钟）`
    : status.realClock
      ? ' · 休市中，下一交易时段开盘后价格随真实行情变动'
      : ' · 休市中，下一次开盘后价格继续变动';

  return (
    <Space size={8} wrap>
      <Tag color={color} icon={<FieldTimeOutlined />} data-testid="market-phase">
        {phaseText}
      </Tag>
      <Tooltip title={`交易日序号 ${status.tradeSeq}（收盘结算后自动进入下一交易日）`}>
        <Tag>交易日 {status.tradeDate}</Tag>
      </Tooltip>
      <span style={{ fontSize: 12, color: '#8c8c8c' }}>{schedule}</span>
    </Space>
  );
}

// RQ-33 深色模式 / 信息密度切换
export function ThemeControls({
  theme,
  density,
  onChange,
}: {
  theme: 'light' | 'dark';
  density: 'compact' | 'normal' | 'loose';
  onChange: (p: { theme?: 'light' | 'dark'; density?: 'compact' | 'normal' | 'loose' }) => void;
}) {
  return (
    <Space size={4}>
      <Tooltip title={theme === 'light' ? '切换深色模式' : '切换浅色模式'}>
        <Tag
          color={theme === 'dark' ? 'geekblue' : undefined}
          style={{ cursor: 'pointer' }}
          onClick={() => onChange({ theme: theme === 'light' ? 'dark' : 'light' })}
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? <MoonOutlined /> : <SunOutlined />} {theme === 'dark' ? '深色' : '浅色'}
        </Tag>
      </Tooltip>
      <Tooltip title="信息密度">
        <Tag
          style={{ cursor: 'pointer' }}
          onClick={() => onChange({ density: density === 'compact' ? 'normal' : 'compact' })}
          data-testid="density-toggle"
        >
          {density === 'compact' ? '紧凑' : '标准'}
        </Tag>
      </Tooltip>
    </Space>
  );
}
