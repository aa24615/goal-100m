/**
 * 达标进度与「距下一档还差 N 笔」（RQ-117）
 *
 * v8 的护栏是**拦截**：不达标就不展示。用户看到的是空页面 + 一句「样本不足」，
 * 不知道自己离能看数字还差多远。v9 改成**牵引**：未达标直接显示还差多少。
 *
 * 口径与体检单同源（服务端复用 checkupService.resolveTier），本组件不另算一套。
 */

import React from 'react';
import { Card, Progress, Space, Tag, Typography, Alert } from 'antd';
import type { TierProgressPayload } from '../types';

const { Text } = Typography;

export interface TierProgressCardProps {
  data: TierProgressPayload | null;
  /** 关闭达标提示：由父页面持久化，服务端不存 UI 状态 */
  onDismiss?: (key: string) => void;
}

export default function TierProgressCard({ data, onDismiss }: TierProgressCardProps) {
  if (!data) return null;

  return (
    <Card size="small" title="距下一档还差多少" data-testid="tier-progress">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Tag color="blue" data-testid="tier-current">
            当前「{data.tier.label}」档 · {data.sampleSize} 笔
          </Tag>
          {data.next && (
            <Tag data-testid="tier-next">
              下一档「{data.next.label}」需 {data.next.threshold} 笔
            </Tag>
          )}
        </Space>

        <Progress
          percent={data.progressPct}
          size="small"
          status={data.reachedTop ? 'success' : 'active'}
          data-testid="tier-progress-bar"
        />

        <Text style={{ fontSize: 13 }} data-testid="tier-message">
          {data.message}
        </Text>

        {data.gates.map((g) => (
          <div key={g.key} style={{ fontSize: 12 }} data-testid={`tier-gate-${g.key}`}>
            <Text type="secondary">
              {g.label}：{g.current}/{g.threshold} 笔
            </Text>
            {!g.reached && <Tag color="orange">还差 {g.remaining} 笔</Tag>}
            {g.reached && <Tag color="green">已跨过</Tag>}
          </div>
        ))}

        {data.notices.map((n) => (
          <Alert
            key={n.key}
            type="success"
            showIcon
            closable
            style={{ fontSize: 12 }}
            data-testid={`tier-notice-${n.kind}`}
            message={n.title}
            description={
              <>
                <div>{n.body}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {n.cannot}
                </Text>
              </>
            }
            onClose={() => onDismiss?.(n.key)}
          />
        ))}

        <Text type="secondary" style={{ fontSize: 12 }}>
          {data.note}
        </Text>
      </Space>
    </Card>
  );
}
