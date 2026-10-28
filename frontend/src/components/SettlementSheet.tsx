/**
 * 结算口径说明书（RQ-125 / I-13 / F-53）
 *
 * 要消除的是一句没说出口的怀疑：**「这个模拟成交价是不是假的？」**
 * 一旦用户起了疑心，整个训练的价值归零——他不会再相信任何一张成绩卡。
 * 海外头部 TradingSim（$33/月起）在公开评测里被反复批评成交价不实，
 * 说明「模拟撮合可核对」并不是行业默认项，而是可以拿来做差异化的东西。
 *
 * 因此这里做两件事：
 *   1. 逐笔摊开成交价、金额、费用拆解（佣金/印花税/过户费/最低佣金）；
 *   2. 把 T+1、涨跌停、整手、滑点写成一页人话，并给出「怎么自己核对」。
 *
 * 组件不计算任何数字——全部来自后端 `buildSettlementSheet`，
 * 避免出现「前端算一套、后端记一套」的第二口径。
 */

import React, { useState } from 'react';
import { Card, Space, Tag, Typography, Table, Alert, Button } from 'antd';
import { CalculatorOutlined } from '@ant-design/icons';
import type { SettlementPayload } from '../types';

const { Text, Paragraph } = Typography;

export interface SettlementSheetProps {
  data: SettlementPayload | null;
  loading?: boolean;
}

function money(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `¥${Number(v).toFixed(2)}`;
}

export default function SettlementSheet({ data, loading = false }: SettlementSheetProps) {
  const [open, setOpen] = useState(false);
  if (!data) return null;

  const rules = data.rules ?? [];
  const orders = data.orders ?? [];

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <CalculatorOutlined style={{ color: '#0d9488' }} />
          <span>{data.title || '本局结算口径'}</span>
        </Space>
      }
      data-testid="settlement-sheet"
      loading={loading}
      extra={
        <Button size="small" onClick={() => setOpen((v) => !v)} data-testid="settlement-toggle">
          {open ? '收起明细' : '逐笔核对'}
        </Button>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div data-testid="settlement-summary" style={{ fontSize: 13 }}>
          {data.summary}
        </div>

        {!data.applicable ? (
          <Alert
            type="info"
            showIcon={false}
            style={{ fontSize: 12 }}
            data-testid="settlement-not-applicable"
            message="本局尚未结算，结算完成后这里会给出逐笔明细。"
          />
        ) : null}

        {/* 费用自检：记账费用与按公开费率重算不一致时必须是醒目的告警，而不是藏在日志里 */}
        <Alert
          type={data.feeAudit?.ok ? 'success' : 'error'}
          showIcon={false}
          style={{ fontSize: 12 }}
          data-testid="settlement-fee-audit"
          message={
            data.feeAudit?.ok
              ? `费用自检通过：${data.feeAudit.checked} 笔成交的记账费用与公开费率重算一致。`
              : `费用自检未通过：${data.feeAudit?.mismatch ?? 0} 笔不一致，撮合与口径已偏离。`
          }
        />

        {open ? (
          <>
            <Table
              size="small"
              rowKey={(r) => String(r.index)}
              pagination={false}
              data-testid="settlement-orders"
              dataSource={orders}
              locale={{ emptyText: '本局没有成交（全程观望）。' }}
              columns={[
                { title: '#', dataIndex: 'index', width: 36 },
                { title: '方向', dataIndex: 'sideLabel', width: 56 },
                { title: '数量', dataIndex: 'quantity', width: 70 },
                {
                  title: '成交价',
                  dataIndex: 'price',
                  width: 80,
                  render: (v: number | null) => money(v),
                },
                {
                  title: '金额',
                  dataIndex: 'amount',
                  width: 90,
                  render: (v: number) => money(v),
                },
                {
                  title: '费用',
                  dataIndex: 'fee',
                  width: 80,
                  render: (v: number, r) => (
                    <span data-testid="settlement-fee">
                      {money(v)}
                      {r.feeBreakdown?.minCommissionApplied ? (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {' '}
                          (最低佣金)
                        </Text>
                      ) : null}
                    </span>
                  ),
                },
                {
                  title: '已实现盈亏',
                  dataIndex: 'realizedPnl',
                  width: 100,
                  render: (v: number | null) => (v == null ? '—' : money(v)),
                },
              ]}
            />

            <div data-testid="settlement-reconciliation" style={{ fontSize: 12 }}>
              {data.reconciliation}
            </div>
          </>
        ) : null}

        <div data-testid="settlement-rules">
          {rules.map((r) => (
            <Paragraph key={r.key} style={{ fontSize: 12, marginBottom: 6 }}>
              <Text strong>{r.title}</Text>：{r.body}
              <br />
              <Text type="secondary">怎么核对：{r.verifiable}</Text>
            </Paragraph>
          ))}
        </div>

        <Space size={6} wrap>
          <Tag data-testid="settlement-total-fee">费用合计 {money(data.totals?.fee)}</Tag>
          <Tag data-testid="settlement-total-amount">成交额 {money(data.totals?.amount)}</Tag>
        </Space>

        <Text type="secondary" style={{ fontSize: 11 }}>
          {data.disclaimer}
        </Text>
      </Space>
    </Card>
  );
}
