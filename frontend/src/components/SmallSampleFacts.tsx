/**
 * 小样本「仍然能说的三件事」（RQ-111 / I-7）
 *
 * 竞品在样本不足时给的是空白页或门槛拦截，而我们可以给「你现在能确定的三件事」——
 * 这是 v9 判定为「唯一仍在的差异化窗口」的落地核心。
 *
 * 三类事实按行业方法论区分：
 *   成本事实（手续费 / 滑点）——不需要样本，是本局已发生的事实；
 *   行为事实（止损执行率 / 追高比例 / 持有时长）——只需要计数，不需要推断；
 *   对照事实（跑赢买入持有与否）——单次对照不说明策略好坏，但确实能回答「这一局跑赢了什么」。
 *
 * 硬约束 3：样本门槛不得因「页面太空」被砍。这里用三件事补位，
 * 而不是塞进胜率与期望值——那才叫伪结论。
 */

import React from 'react';
import { Card, List, Tag, Typography, Alert, Button, Space } from 'antd';
import { CheckCircleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { SmallSamplePayload } from '../types';

const { Text, Paragraph } = Typography;

export interface SmallSampleFactsProps {
  data: SmallSamplePayload | null;
  /** 点击「下一步动作」的跳转：由父页面注入，组件本身不持有路由 */
  onAction?: (path: string) => void;
}

export default function SmallSampleFacts({ data, onAction }: SmallSampleFactsProps) {
  if (!data) return null;

  const available = (data.facts || []).filter((f) => f.available);

  return (
    <Card
      size="small"
      title="你现在能确定的事"
      data-testid="small-sample-facts"
      extra={
        <Tag color={data.smallSample ? 'orange' : 'green'} data-testid="small-sample-tag">
          {data.sampleSize} 笔 · {data.smallSample ? '小样本' : '已达护栏'}
        </Tag>
      }
    >
      <List
        size="small"
        dataSource={data.facts || []}
        locale={{ emptyText: '暂无可读事实' }}
        renderItem={(f) => (
          <List.Item data-testid={`small-sample-fact-${f.key}`}>
            <List.Item.Meta
              avatar={
                f.available ? (
                  <CheckCircleOutlined style={{ color: '#0d9488' }} />
                ) : (
                  <Tag>待积累</Tag>
                )
              }
              title={
                <Space size={6}>
                  <Text strong style={{ fontSize: 13 }}>
                    {f.kind}
                  </Text>
                  {f.needsSample === false && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      不需要样本即可确认
                    </Text>
                  )}
                </Space>
              }
              description={
                <>
                  <div style={{ fontSize: 13 }}>{f.headline}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {f.detail}
                  </Text>
                </>
              }
            />
          </List.Item>
        )}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 8 }}
        data-testid="small-sample-next-action"
        message={data.nextAction?.label}
        description={
          <Space direction="vertical" size={4}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {data.nextAction?.hint}
            </Text>
            {onAction && data.nextAction?.cta && (
              <Button
                size="small"
                type="link"
                style={{ paddingLeft: 0 }}
                data-testid="small-sample-action-cta"
                onClick={() => onAction(data.nextAction.cta)}
              >
                去训练 <ArrowRightOutlined />
              </Button>
            )}
          </Space>
        }
      />

      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        {data.disclaimer}
      </Paragraph>

      {/* 守护：小样本时把「暂不展示」的断言显式列出来，避免用户以为是为 0 */}
      {data.blockedAssertions?.length > 0 && (
        <div data-testid="small-sample-blocked" style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            暂不展示：
          </Text>
          {data.blockedAssertions.map((b) => (
            <Tag key={b} style={{ fontSize: 11 }}>
              {b}
            </Tag>
          ))}
        </div>
      )}
    </Card>
  );
}
