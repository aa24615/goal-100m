/**
 * 已归档功能提示（RQ-116）
 *
 * 零使用功能此前只是「折叠」：路由还在，老书签 / 直达地址进来的仍是空页面，
 * 且没有任何解释（F-39）。本期改为**下线**：显式标注已归档并给出替代入口。
 *
 * 用「已归档」而不是 404：404 会被当成故障，而这是主动下线。
 */

import React from 'react';
import { Result, Button, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';

const { Paragraph } = Typography;

export interface ArchivedNoticeProps {
  label: string;
  archivedAt?: string;
  reason?: string;
  replacement?: { path: string; label: string } | null;
}

export default function ArchivedNotice({
  label,
  archivedAt = '2026-10-28',
  reason = '该功能使用量为零，且与我们选定的训练定位不一致，已主动下线。',
  replacement = { path: '/blind', label: '双盲训练（真实历史行情）' },
}: ArchivedNoticeProps) {
  const navigate = useNavigate();
  return (
    // antd 的 Result 不透传 data-testid，因此外层套一个容器承载测试锚点
    <div data-testid="archived-notice">
    <Result
      status="info"
      title={`${label}已归档`}
      subTitle={`已于 ${archivedAt} 下线，不再维护。`}
      extra={
        replacement ? (
          <Button type="primary" data-testid="archived-replacement" onClick={() => navigate(replacement.path)}>
            去{replacement.label}
          </Button>
        ) : null
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 13 }} data-testid="archived-reason">
        {reason}
      </Paragraph>
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        归档不等于故障：这是主动下线，历史数据不再产生新记录。
      </Paragraph>
    </Result>
    </div>
  );
}
