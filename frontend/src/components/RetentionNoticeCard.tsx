/**
 * 数据保留期提示（RQ-154 / I-25）
 *
 * 竞品 8 家**无一明确保留期**；FX Replay 免费档「1 周保留 / 50 笔」被测评定性为
 * 「永远攒不到 100 笔样本」——保留期短是隐性劝退点：用户不敢投入三个月，怕数据没了。
 *
 * 因此承诺要写在**用户投入之前**（注册页 + 训练页），而不是藏在条款里。
 *
 * 硬约束：**文案一律来自后端 payload**，前端不复制常量。
 * 复制一份必然漂移，最后变成「页面说永久、实际 7 天」的信任事故。
 */

import React from 'react';
import { Alert, Space, Button, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import type { RetentionPayload } from '../types';

const { Text } = Typography;

export default function RetentionNoticeCard({
  data,
  onRegister,
}: {
  data: RetentionPayload | null;
  onRegister?: () => void;
}) {
  if (!data) return null;

  return (
    <Alert
      type={data.urgent ? 'warning' : 'info'}
      showIcon
      icon={<SafetyCertificateOutlined />}
      data-testid="retention-notice"
      message={data.title}
      description={
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>{data.body}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {data.exportHint}
          </Text>
          {data.cta && onRegister && (
            <Button size="small" type="primary" onClick={onRegister} data-testid="retention-register">
              {data.cta.label}
            </Button>
          )}
        </Space>
      }
    />
  );
}
