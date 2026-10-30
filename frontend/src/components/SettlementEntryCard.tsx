/**
 * 结算口径说明书入口卡（RQ-151 / F-82）
 *
 * v12 §4 F-82：**结算页已上线但用户找不到**——入口只在 Blind 页成绩区里，
 * 训练页、复盘页、首页都没有。v11 押注的第一差异化因此等于没兑现。
 *
 * 本组件把入口做成**可复用的卡片**，三处共用同一个出口：
 *   ① 训练页（`/training`）    ② 复盘页（`/review`）    ③ 训练成绩区（Blind 页，用完整面板）
 *
 * 设计约束：
 *   - **有最近一局就直接跳过去**，不要让用户先自己找会话 ID；
 *   - 没有已结算的局时**说明为什么**，而不是渲染一个点了没反应的按钮；
 *   - 口径条数由后端给，前端不复制常量（避免第二口径漂移）。
 */

import React from 'react';
import { Card, Button, Space, Typography, Alert } from 'antd';
import { FileSearchOutlined } from '@ant-design/icons';

const { Text, Paragraph } = Typography;

export default function SettlementEntryCard({
  lastFinishedId,
  onOpen,
  compact = false,
}: {
  /** 最近一局已结算的训练 ID；为 null 时给出「先完成一局」的说明 */
  lastFinishedId: number | null;
  onOpen: (sessionId: number) => void;
  compact?: boolean;
}) {
  return (
    <Card
      size="small"
      title={
        <Space>
          <FileSearchOutlined />
          <span>结算口径说明书</span>
        </Space>
      }
      data-testid="settlement-entry"
    >
      {compact ? (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            每一笔成交的价从哪来、费怎么拆、被拒的委托违反了哪条规则，都可以逐条展开核对。
          </Text>
          {lastFinishedId != null ? (
            <Button size="small" type="link" style={{ paddingLeft: 0 }} onClick={() => onOpen(lastFinishedId)}>
              查看最近一局结算明细
            </Button>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              完成一局训练后，这里可以直接进入结算明细。
            </Text>
          )}
        </Space>
      ) : (
        <>
          <Paragraph style={{ fontSize: 12, marginBottom: 8 }}>
            模拟盘最容易被怀疑的是「这个成交价是不是假的」。因此每一笔成交都给出
            <Text strong> 撮合价取自哪一根 K 线</Text>、
            <Text strong> 费用逐项</Text>（佣金 / 印花税 / 过户费）、以及
            <Text strong> 与真实规则的差异清单</Text>，可逐条展开核对，也可以一键复制带走。
          </Paragraph>
          {lastFinishedId != null ? (
            <Button type="primary" size="small" onClick={() => onOpen(lastFinishedId)} data-testid="settlement-entry-open">
              查看最近一局结算明细
            </Button>
          ) : (
            <Alert
              type="info"
              showIcon
              message="还没有可核对的结算"
              description="走完一局训练（至少一笔成交）后，这里会直接进入结算明细。"
            />
          )}
        </>
      )}
    </Card>
  );
}
