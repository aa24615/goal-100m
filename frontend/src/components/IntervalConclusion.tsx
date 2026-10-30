/**
 * 区间化结论（RQ-152 / RQ-153 / I-23）
 *
 * 竞品调研的路线级结论：**「样本量门槛」已被公共知识覆盖（30/50 笔），不再是空位；
 * 但「给区间」没人做**。因此本组件把结论全部改成「区间 + 达标线 + 还差多少笔」：
 *
 *   - 样本 <50 笔 → `three-facts`：只展示成本事实 / 行为事实 / 对照事实，**不出现任何点估计**；
 *   - 样本 ≥50 笔 → `interval`：期望值给 95% 区间与 t 值，并标明 t>1.96 / 执行率≥80% /
 *     实际胜率 ≥ 盈亏平衡胜率 +5pp 三条达标线。
 *
 * 硬约束（F-19 伪结论的复发路径）：
 *   **样本不足时禁止点估计**。给一个「标红的胜率 60%」等于什么都没挡住——用户只会记住 60。
 *   因此这里在小样本模式下连数字都不渲染，只渲染「还差 N 笔」。
 */

import React from 'react';
import { Card, Space, Tag, Typography, Progress, Alert, Empty } from 'antd';
import type { ConclusionPayload } from '../types';

const { Text, Paragraph } = Typography;

const LEVEL_COLOR: Record<string, string> = {
  pass: 'green',
  fail: 'red',
  insufficient: 'default',
  'no-threshold': 'blue',
};
const LEVEL_TEXT: Record<string, string> = {
  pass: '已过线',
  fail: '未过线',
  insufficient: '尚不能下结论',
  'no-threshold': '无达标线',
};

export default function IntervalConclusion({ data }: { data: ConclusionPayload | null }) {
  if (!data) return null;

  // 小样本：只给「能说的三件事」+ 还差多少笔，不给任何点估计
  if (data.mode === 'three-facts') {
    const facts = data.facts;
    return (
      <Card size="small" title="现在就能确定的三件事" data-testid="conclusion-three-facts">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="conclusion-headline"
          message={data.headline}
          description="胜率与期望值属于对未来的推断，样本不够时算出来也不能信——所以这里一个数字都不给。"
        />
        {!facts || facts.sayableCount === 0 ? (
          <Empty description="完成第一笔成交后，这里会给出成本与行为事实" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {(facts.facts || [])
              .filter((f) => f.available)
              .map((f) => (
                <div key={f.key} data-testid={`conclusion-fact-${f.key}`}>
                  <Space>
                    <Tag color="blue">{f.kind}</Tag>
                    <Text strong>{f.headline}</Text>
                  </Space>
                  <Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
                    {f.detail}
                  </Paragraph>
                </div>
              ))}
          </Space>
        )}
        <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
          还差 {data.remaining} 笔（门槛 {data.threshold} 笔）才能谈胜率与期望值。
        </Paragraph>
      </Card>
    );
  }

  const iv = data.interval;
  if (!iv) return null;

  return (
    <Card size="small" title="结论（带 95% 区间与达标线）" data-testid="conclusion-interval">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        data-testid="conclusion-headline"
        message={data.headline}
        description={iv.method}
      />
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {iv.metrics.map((m) => (
          <div key={m.key} data-testid={`conclusion-metric-${m.key}`}>
            <Space wrap>
              <Text strong>{m.label}</Text>
              {m.point != null && (
                <Text data-testid={`conclusion-point-${m.key}`}>
                  {m.point}
                  {m.unit || ''}
                </Text>
              )}
              {m.interval && (
                <Text type="secondary" data-testid={`conclusion-interval-${m.key}`}>
                  95% 区间 {m.interval.low} ~ {m.interval.high}
                  {m.unit || ''}
                </Text>
              )}
              {m.t != null && <Text type="secondary">t={m.t}</Text>}
              {m.verdict && <Tag color={LEVEL_COLOR[m.verdict.level]}>{LEVEL_TEXT[m.verdict.level]}</Tag>}
            </Space>
            {m.threshold && (
              <Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
                达标线：{m.threshold.label}
                {m.verdict?.level === 'fail' && m.threshold.why ? ` —— ${m.threshold.why}` : ''}
              </Paragraph>
            )}
            {!m.conclusive && (
              <Progress
                percent={Math.min(100, Math.round((m.sampleSize / m.remaining ? m.sampleSize / (m.sampleSize + m.remaining) : 0) * 100))}
                size="small"
                format={() => `还差 ${m.remaining} 笔`}
              />
            )}
          </div>
        ))}
        {iv.breakeven.available && (
          <div data-testid="conclusion-breakeven">
            <Space wrap>
              <Text strong>盈亏平衡胜率</Text>
              <Text>
                {((iv.breakeven.winRate ?? 0) * 100).toFixed(2)}%（实际{' '}
                {((iv.breakeven.actual ?? 0) * 100).toFixed(2)}%，差{' '}
                {((iv.breakeven.margin ?? 0) * 100).toFixed(2)}pp）
              </Text>
              <Tag color={iv.breakeven.pass ? 'green' : 'red'}>{iv.breakeven.pass ? '已过线' : '未过线'}</Tag>
            </Space>
            <Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
              {iv.breakeven.label}
            </Paragraph>
          </div>
        )}
      </Space>
      <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
        {iv.disclaimer}
      </Paragraph>
    </Card>
  );
}
