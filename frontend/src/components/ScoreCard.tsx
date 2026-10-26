/**
 * 训练成绩卡（RQ-99 / I-5）
 *
 * 解决 F-24：训练成绩带不走——练完即走，既没有回来的理由，也没有分享抓手。
 * 成绩卡把一次训练压缩成一张**可复制为纯文本**的结论卡：
 *   做了什么 / 纪律执行率 / 样本贡献 / 距下一档还差多少
 * 所有数字与体检单同源，且**不承诺任何实物或现金奖励**（合规硬约束）。
 */

import React, { useState } from 'react';
import { Card, Button, Space, Typography, Tag, App as AntApp } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import type { ScoreCardPayload } from '../types';

const { Text, Paragraph } = Typography;

/**
 * 复制文本。剪贴板 API 在部分环境（http 非安全上下文、旧 Safari、jsdom）不可用，
 * 因此降级为「选中一个只读 textarea 再 execCommand」，绝不直接抛错把页面打崩。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的降级分支 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export interface ScoreCardProps {
  data: ScoreCardPayload | null;
  onCopied?: () => void | Promise<void>;
  isMobile?: boolean;
}

export default function ScoreCard({ data, onCopied, isMobile = false }: ScoreCardProps) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);

  if (!data) return null;

  const doCopy = async () => {
    const ok = await copyText(data.text);
    if (ok) {
      setCopied(true);
      message.success('成绩卡已复制');
      await onCopied?.();
    } else {
      // 复制失败也要给出口：文本本身就在页面上，用户可以手动选中
      message.info('浏览器不支持自动复制，请手动选中下方文本');
    }
  };

  return (
    <Card
      size="small"
      title={data.title}
      data-testid="score-card"
      extra={
        <Button
          size="small"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={doCopy}
          data-testid="score-card-copy"
        >
          {copied ? '已复制' : '复制文本'}
        </Button>
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Tag color="blue" data-testid="score-card-tier">
          {data.subtitle} · 可信度「{data.tier.label}」档
        </Tag>
        {(data.lines || []).map((l) => (
          <div key={l} style={{ fontSize: isMobile ? 12 : 13 }}>
            {l}
          </div>
        ))}
        <Paragraph
          type="secondary"
          style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}
          data-testid="score-card-disclaimer"
        >
          {data.disclaimer}
        </Paragraph>
      </Space>
    </Card>
  );
}

/** 无数据的占位（成绩未生成时也要有出口，不能是一片空白） */
export function ScoreCardEmpty() {
  return (
    <Card size="small" title="训练成绩卡" data-testid="score-card-empty">
      <Text type="secondary">完成一次训练后，这里会生成一张可复制的成绩卡。</Text>
    </Card>
  );
}
