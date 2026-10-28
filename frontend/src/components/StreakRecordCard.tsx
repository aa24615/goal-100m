/**
 * 个人连打记录（RQ-126 / I-15 / F-51）
 *
 * 竞品实测证据：大波浪「近 30 天净胜局榜」**只有 9 人上榜**。
 * 这说明了两件事——这个赛道整体冷启动都极难，而且
 * **一个只有 9 个人的榜单摆在新用户面前，传递的是「这里没人」**。
 * 空榜在冷启动期是负资产，所以把留存钩子从「和人比」换成「和上周的自己比」：
 * 后者在任何用户量下都有意义，且不依赖别人也在用。
 *
 * 组件刻意**不接收任何收益率字段**：连打只数参与天数，不掺绩效口径。
 */

import React from 'react';
import { Card, Space, Statistic, Typography, Tag, Tooltip } from 'antd';
import { CalendarOutlined } from '@ant-design/icons';
import type { StreakRecordPayload } from '../types';

const { Text } = Typography;

export interface StreakRecordCardProps {
  record: StreakRecordPayload | null | undefined;
  /** 公榜未开放的原因：由父组件传入，避免本组件再去取一次榜单 */
  boardReason?: string | null;
}

/** 日历格子：参与=实心，未参与=空心。用 title 与 data-testid 保证可断言 */
function DayCell({ date, participated }: { date: string; participated: boolean }) {
  return (
    <Tooltip title={`${date} · ${participated ? '已练' : '未练'}`}>
      <span
        data-testid="streak-day"
        data-date={date}
        data-participated={participated ? 'yes' : 'no'}
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: 2,
          background: participated ? '#0d9488' : '#e5e7eb',
          border: '1px solid #d1d5db',
        }}
      />
    </Tooltip>
  );
}

export default function StreakRecordCard({ record, boardReason }: StreakRecordCardProps) {
  if (!record) {
    return (
      <Card size="small" title="连打记录" data-testid="streak-record-empty">
        <Text type="secondary" style={{ fontSize: 12 }}>
          还没有连打记录。完成第一次训练后，这里会开始记录。
        </Text>
      </Card>
    );
  }

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <CalendarOutlined style={{ color: '#0d9488' }} />
          <span>连打记录</span>
        </Space>
      }
      data-testid="streak-record"
      extra={
        <Tag color={record.current > 0 ? 'teal' : 'default'} data-testid="streak-current">
          连续 {record.current} 天
        </Tag>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space size={16} wrap>
          <Statistic title="本周已练" value={record.thisWeek} suffix="天" valueStyle={{ color: '#0d9488' }} />
          <Statistic title="上周同期" value={record.lastWeek} suffix="天" />
          <Statistic
            title="最长连打"
            value={record.longest}
            suffix="天"
            valueStyle={{ color: record.longest > 0 ? '#0d9488' : undefined }}
          />
        </Space>

        <div data-testid="streak-comparison" style={{ fontSize: 13 }}>
          {record.comparison}
        </div>

        <div data-testid="streak-calendar" style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {record.calendar.map((d) => (
            <DayCell key={d.date} date={d.date} participated={d.participated} />
          ))}
        </div>

        <Text type="secondary" style={{ fontSize: 12 }} data-testid="streak-metric">
          {record.metricDef}
        </Text>

        {boardReason ? (
          <Text type="secondary" style={{ fontSize: 12 }} data-testid="streak-board-reason">
            {boardReason}
          </Text>
        ) : null}
      </Space>
    </Card>
  );
}
