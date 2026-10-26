/**
 * 首训直达卡片（RQ-92 / I-3）
 *
 * 当前基线：双盲训练开始 4 次、决策 0 次、完成 0 次（F-16）。
 * 用户不是不想练，是**不知道下一步做什么**——首访落在行情中心，
 * 在没有持仓、没有样本的时候看到的仍然是「交易」而不是「练」（F-21）。
 *
 * 因此本卡片刻意不做任何前置条件：
 *   - 不要求先有持仓；
 *   - 不要求先积累样本；
 *   - 不要求先读懂规则。
 * 目标只有一个：让第一次判断真的发生（≤3 次点击、≤60 秒）。
 */

import React from 'react';
import { Card, Button, Space, Typography, Tag, Alert } from 'antd';
import { ThunderboltOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { FIRST_TRAINING } from '../constants';

const { Title, Text, Paragraph } = Typography;

export interface FirstTrainingCardProps {
  /** 是否已有进行中的训练（有则主按钮改为「继续」） */
  hasRunningSession?: boolean;
  loading?: boolean;
  /** 点击主 CTA：由父页面负责开训并跳转 */
  onStart: () => void | Promise<void>;
  /** 手机端：按钮变大、纵向排布 */
  isMobile?: boolean;
}

export default function FirstTrainingCard({
  hasRunningSession = false,
  loading = false,
  onStart,
  isMobile = false,
}: FirstTrainingCardProps) {
  return (
    <Card data-testid="first-training-card">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Title level={4} style={{ margin: 0 }}>
            {FIRST_TRAINING.title}
          </Title>
          <Tag icon={<ClockCircleOutlined />} color="green" data-testid="first-training-budget">
            ≤{FIRST_TRAINING.goalSeconds} 秒 · ≤{FIRST_TRAINING.maxClicks} 次点击
          </Tag>
        </Space>
        <Text type="secondary">{FIRST_TRAINING.subtitle}</Text>

        <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
          {FIRST_TRAINING.steps.map((s) => (
            <li key={s}>
              <Text style={{ fontSize: 13 }}>{s}</Text>
            </li>
          ))}
        </ol>

        <Button
          type="primary"
          size={isMobile ? 'large' : 'middle'}
          block={isMobile}
          icon={<ThunderboltOutlined />}
          loading={loading}
          onClick={() => onStart()}
          data-testid="first-training-start"
        >
          {hasRunningSession ? '继续上一次训练' : FIRST_TRAINING.cta}
        </Button>

        <Alert
          type="info"
          showIcon={false}
          style={{ fontSize: 12 }}
          data-testid="first-training-note"
          message={FIRST_TRAINING.note}
        />
      </Space>
    </Card>
  );
}
