/**
 * 结算口径说明书 · 审计层（RQ-150 / RQ-151 / I-22 / F-62 / F-81）
 *
 * 与 `SettlementSheet` 的分工：
 *   - SettlementSheet 回答「扣了多少费、怎么对账」；
 *   - 本组件回答另外三个问题：**为什么是这个价 / 滑点多少 / 被拒绝的委托去哪了**。
 *
 * 命名刻意避开「逐笔」二字（F-81）：竞品语境里「逐笔」= L2 行情成交明细，
 * 而我们给的是**结算口径说明书**。用错词会让用户带着「看成交明细」的期待进来，
 * 看到费用计算表后失望离开。
 *
 * 验收对应：
 *   - 每笔成交可展开到费用明细（Collapse 逐笔展开）；
 *   - 与真实规则差异清单 ≥5 条（rules 由后端给出，这里不复制常量）；
 *   - 差异清单可一键复制（复制走的是后端 `text`，与页面同源）。
 */

import React, { useState } from 'react';
import { Card, Collapse, Tag, Typography, Button, Space, Table, Alert, Empty } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import type { SettlementAuditPayload } from '../types';
import { settlementAuditCsvUrl } from '../api';

const { Text, Paragraph } = Typography;

export default function SettlementAuditPanel({
  data,
  sessionId,
}: {
  data: SettlementAuditPayload | null;
  sessionId: number | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;

  const ruleText = [
    '【结算口径说明书 · 赚一个小目标】',
    ...(data.rules || []).map((r, i) => `${i + 1}. ${r.title}：${r.body}（怎么核对：${r.verifiable}）`),
    `${(data.rules?.length ?? 0) + 1}. ${data.slippageRule?.title}：${data.slippageRule?.body}（怎么核对：${data.slippageRule?.verifiable}）`,
    data.disclaimer || '',
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ruleText);
    } catch {
      /* 剪贴板不可用时静默：复制是增强，不是主路径 */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const orders = data.orders || [];
  const rejections = data.rejections || [];

  return (
    <Card
      size="small"
      title="结算口径说明书 · 为什么是这个价"
      data-testid="settlement-audit"
      extra={
        <Space>
          <Button size="small" icon={<CopyOutlined />} onClick={copy} data-testid="settlement-audit-copy">
            {copied ? '已复制' : '复制差异清单'}
          </Button>
          {sessionId != null && (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              href={settlementAuditCsvUrl(sessionId)}
              data-testid="settlement-audit-csv"
            >
              导出 CSV
            </Button>
          )}
        </Space>
      }
    >
      {/* 自检：三项全为 0 才能声称「可核对」。有漂移时必须说出来，不能藏进日志（RQ-150） */}
      <Alert
        type={data.audit?.ok ? 'success' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        data-testid="settlement-audit-status"
        message={
          data.audit?.ok
            ? `本局结算可核对：${data.audit.priceChecked} 笔价格、${data.audit.feeChecked} 笔费用均已核对一致`
            : `本局结算存在漂移：价格不一致 ${data.audit?.priceMismatch ?? 0} 笔、费用不一致 ${data.audit?.feeMismatch ?? 0} 笔、未归类拒绝 ${data.audit?.unknownRejections ?? 0} 条`
        }
        description={data.audit?.note}
      />

      {orders.length === 0 ? (
        <Empty description="本局没有成交，暂无可核对的逐笔明细" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Collapse
          size="small"
          items={orders.map((o) => ({
            key: String(o.index),
            label: (
              <Space wrap data-testid={`settlement-audit-line-${o.index}`}>
                <Text strong>第 {o.index} 笔</Text>
                <Text>{o.sideLabel}</Text>
                <Text>{o.quantity} 股</Text>
                <Text>@ ¥{o.price == null ? '—' : o.price.toFixed(2)}</Text>
                {o.priceOrigin?.matched === true && <Tag color="green">价源一致</Tag>}
                {o.priceOrigin?.matched === false && <Tag color="red">价源偏离</Tag>}
                {o.priceOrigin?.hasQuote === false && <Tag>无报价</Tag>}
              </Space>
            ),
            children: (
              <div style={{ fontSize: 12 }} data-testid={`settlement-audit-detail-${o.index}`}>
                <Paragraph style={{ marginBottom: 6 }}>
                  <Text strong>{o.qa?.price?.question}</Text> {o.qa?.price?.answer}
                </Paragraph>
                <Paragraph style={{ marginBottom: 6 }}>
                  <Text strong>{o.qa?.fee?.question}</Text> {o.qa?.fee?.answer}
                </Paragraph>
                <Paragraph style={{ marginBottom: 6 }}>
                  <Text strong>{o.qa?.slippage?.question}</Text> {o.qa?.slippage?.answer}
                </Paragraph>
                <Text type="secondary">{o.text}</Text>
              </div>
            ),
          }))}
        />
      )}

      {rejections.length > 0 && (
        <>
          <Paragraph style={{ marginTop: 12, marginBottom: 6 }}>
            <Text strong>被拒绝的委托（{rejections.length} 条）</Text>
          </Paragraph>
          <Table
            size="small"
            pagination={false}
            rowKey={(r) => `${r.seq}-${r.side}-${r.ruleKey}-${r.reason}`}
            dataSource={rejections}
            data-testid="settlement-audit-rejections"
            columns={[
              { title: 'K线', dataIndex: 'seq', width: 60, render: (v: number | null) => v ?? '—' },
              { title: '方向', dataIndex: 'sideLabel', width: 60 },
              { title: '数量', dataIndex: 'quantity', width: 70 },
              {
                title: '归类',
                dataIndex: 'ruleTitle',
                width: 110,
                render: (v: string, r: any) => <Tag color={r.known ? 'orange' : 'default'}>{v}</Tag>,
              },
              { title: '规则', dataIndex: 'rule' },
              { title: '怎么核对', dataIndex: 'howToVerify' },
              { title: '下一步', dataIndex: 'fix' },
            ]}
          />
        </>
      )}

      <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12, whiteSpace: 'pre-wrap' }}>
        {ruleText}
      </Paragraph>
    </Card>
  );
}
