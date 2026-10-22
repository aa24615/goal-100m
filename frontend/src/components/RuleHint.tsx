import React, { useState } from 'react';
import { Popover, List, Typography, Button, Space, Tag, Alert } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { RULE_HINTS } from '../constants';

const { Text, Paragraph } = Typography;

// RQ-13：交易规则在「需要的那一刻」就地解释，而不是丢给用户一本独立文档。
// 默认收起为一个问号，点开即读；面板内不出现任何收益承诺类表述。
export default function RuleHint({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);

  const content = (
    <div style={{ maxWidth: 320 }}>
      <List
        size="small"
        dataSource={RULE_HINTS}
        renderItem={(r) => (
          <List.Item style={{ display: 'block', padding: '6px 0' }}>
            <Text strong style={{ fontSize: 12 }}>
              {r.title}
            </Text>
            <Paragraph style={{ margin: '2px 0 0', fontSize: 12, color: '#595959' }}>{r.desc}</Paragraph>
          </List.Item>
        )}
      />
      <Alert type="warning" showIcon message="模拟交易，不构成投资建议" style={{ fontSize: 11, marginTop: 4 }} />
    </div>
  );

  return (
    <Popover content={content} title="交易规则" trigger="click" open={open} onOpenChange={setOpen}>
      {compact ? (
        <Button type="link" size="small" icon={<QuestionCircleOutlined />} style={{ padding: 0 }}>
          规则说明
        </Button>
      ) : (
        <Space size={4}>
          <Tag color="teal" style={{ cursor: 'pointer', marginInlineEnd: 0 }}>
            <QuestionCircleOutlined /> 交易规则
          </Tag>
        </Space>
      )}
    </Popover>
  );
}
