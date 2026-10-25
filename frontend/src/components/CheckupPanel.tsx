/**
 * 交易体检单面板（RQ-76 五项决定论指标 / RQ-77 样本门槛 / RQ-78 拆解与提示）
 *
 * 两条硬约束直接体现在 UI 上：
 * 1. **样本 < 50 笔不输出任何结论性判断** —— 不评级、不打标签，
 *    只显示「还差 N 笔」+ 进度条 + 原始流水（RQ-77）。空面板正是该功能的价值所在。
 * 2. **每项指标必须带一行口径说明** —— 「这个数说明什么 / 什么时候该改」，
 *    口径来自后端 METRIC_HINTS，前端不做二次改写（RQ-78）。
 */

import React from 'react';
import { Card, Progress, Statistic, Tag, Typography, Alert, Space, Tooltip, Table, Divider, Empty } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { CheckupPayload, BreakdownGroup, MetricHint } from '../types';
import { formatMoney, formatNum } from '../utils';

const { Text, Paragraph, Title } = Typography;

function HintSuffix({ hint }: { hint: MetricHint }) {
  return (
    <Tooltip title={`${hint.formula}\n说明什么：${hint.meaning}\n何时该改：${hint.whenToChange}`}>
      <InfoCircleOutlined style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
    </Tooltip>
  );
}

function BreakdownTable({ title, groups }: { title: string; groups: BreakdownGroup[] }) {
  return (
    <Table
      size="small"
      rowKey="key"
      pagination={false}
      dataSource={groups}
      title={() => title}
      columns={[
        { title: '分组', dataIndex: 'label' },
        { title: '笔数', dataIndex: 'count', width: 70 },
        {
          title: '盈亏',
          dataIndex: 'pnl',
          align: 'right' as const,
          render: (v: number) => (
            <span style={{ color: v >= 0 ? '#e0584f' : '#2fa06a' }}>{formatMoney(v)}</span>
          ),
        },
      ]}
      locale={{ emptyText: '暂无数据' }}
    />
  );
}

export default function CheckupPanel({ data, loading }: { data: CheckupPayload | null; loading?: boolean }) {
  return (
    <Card title="交易体检单" loading={loading} data-testid="checkup-panel">
      {!data && <Empty description="暂无体检数据" />}
      {data && (
        <>
          {/* RQ-77 样本门槛：无论是否达标，先把「可信度」摆在第一行 */}
          <Alert
            type={data.sufficient ? 'success' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
            data-testid="checkup-gate"
            message={data.gate.message}
            description={
              <Progress
                percent={Math.min(100, Math.round((data.sampleSize / data.threshold) * 100))}
                size="small"
                status={data.sufficient ? 'success' : 'active'}
              />
            }
          />

          {/* 样本不足：不渲染任何评级/标签，只给原始流水 */}
          {!data.sufficient && (
            <>
              <Paragraph type="secondary" style={{ fontSize: 12 }}>
                样本不足时不给结论，是为了不让你拿着 3 笔交易形成的「胜率 67%」去做决策。
                下面是已记录的原始成交，继续练到 {data.threshold} 笔即可解锁完整评估。
              </Paragraph>
              <Table
                size="small"
                rowKey="sellId"
                pagination={{ pageSize: 8 }}
                dataSource={data.rawRounds as Array<Record<string, unknown>>}
                columns={[
                  { title: '标的', dataIndex: 'code' },
                  { title: '数量', dataIndex: 'quantity', width: 80 },
                  { title: '卖出价', dataIndex: 'sellPrice', render: (v: number) => formatNum(v) },
                  {
                    title: '盈亏',
                    dataIndex: 'realizedPnl',
                    align: 'right' as const,
                    render: (v: number) => (
                      <span style={{ color: v >= 0 ? '#e0584f' : '#2fa06a' }}>{formatMoney(v)}</span>
                    ),
                  },
                  { title: '持有(天)', dataIndex: 'holdDays', width: 90 },
                ]}
                locale={{ emptyText: '还没有完整的买卖回合' }}
              />
              <Divider />
              <Text type="secondary" style={{ fontSize: 12 }}>
                以下数值仍会展示，但仅供观察，**不代表你的能力结论**。
              </Text>
            </>
          )}

          {/* RQ-76 五项决定论指标 */}
          <Space size="large" wrap style={{ marginTop: 16 }}>
            <div data-testid="metric-expectancy">
              <Statistic
                title={
                  <span>
                    期望值（元/笔）<HintSuffix hint={data.expectancy.hint} />
                  </span>
                }
                value={data.expectancy.amount}
                precision={2}
                valueStyle={{ color: data.expectancy.amount >= 0 ? '#e0584f' : '#2fa06a' }}
              />
            </div>
            <div data-testid="metric-expectancy-r">
              <Statistic
                title={
                  <span>
                    期望值（R）<HintSuffix hint={data.expectancyR.hint} />
                  </span>
                }
                value={data.expectancyR.value == null ? '—' : data.expectancyR.value}
                precision={data.expectancyR.value == null ? 0 : 2}
              />
            </div>
            <div data-testid="metric-r-multiple">
              <Statistic
                title={
                  <span>
                    平均 R 倍数<HintSuffix hint={data.rMultiple.hint} />
                  </span>
                }
                value={data.rMultiple.avgR == null ? '—' : data.rMultiple.avgR}
                precision={data.rMultiple.avgR == null ? 0 : 2}
              />
            </div>
            <div data-testid="metric-hold-ratio">
              <Statistic
                title={
                  <span>
                    亏损/盈利持仓天数比<HintSuffix hint={data.holdTime.hint} />
                  </span>
                }
                value={data.holdTime.ratio == null ? '—' : data.holdTime.ratio}
                precision={data.holdTime.ratio == null ? 0 : 2}
              />
            </div>
            <div data-testid="metric-discipline">
              <Statistic
                title={
                  <span>
                    纪律执行率<HintSuffix hint={data.discipline.hint} />
                  </span>
                }
                value={data.discipline.rate == null ? '—' : data.discipline.rate}
                precision={data.discipline.rate == null ? 0 : 2}
                suffix={data.discipline.rate == null ? '' : '%'}
              />
            </div>
          </Space>

          <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
            持仓对比：盈利单平均持有 {data.holdTime.winHoldDays ?? '—'} 天，亏损单平均持有{' '}
            {data.holdTime.lossHoldDays ?? '—'} 天。纪律执行率口径：{data.discipline.note}
            {data.discipline.total === 0 && '（先去双盲训练记录几次判断，这个数才会出现）'}
          </Paragraph>

          {/* RQ-76 最坏习惯的美元成本 */}
          {data.worstHabit && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              data-testid="worst-habit"
              message={`最坏习惯：${data.worstHabit.label} · 代价 ${formatMoney(data.worstHabit.cost)}`}
              description={data.worstHabit.detail}
            />
          )}

          {/* RQ-77 达到门槛后才出现的结论 */}
          {data.sufficient && data.verdict && (
            <Alert
              type={data.verdict.hasEdge ? 'success' : 'error'}
              showIcon
              style={{ marginTop: 12 }}
              data-testid="checkup-verdict"
              message={data.verdict.summary}
              description={data.verdict.disclaimer}
            />
          )}

          {/* RQ-78 按维度拆解，每条分组可回溯到原始成交行 */}
          {data.sufficient && (
            <>
              <Divider orientation="left">盈亏拆解（点击分组定位到原始成交）</Divider>
              <Space size="large" wrap align="start" style={{ width: '100%' }}>
                <div style={{ minWidth: 240 }}>
                  <BreakdownTable title="按持仓时长" groups={data.breakdown.byHold} />
                </div>
                <div style={{ minWidth: 240 }}>
                  <BreakdownTable title="按交易时段" groups={data.breakdown.bySession} />
                </div>
                <div style={{ minWidth: 240 }}>
                  <BreakdownTable title="按星期" groups={data.breakdown.byWeekday} />
                </div>
                <div style={{ minWidth: 240 }}>
                  <BreakdownTable title="按来源" groups={data.breakdown.bySource} />
                </div>
              </Space>
            </>
          )}
        </>
      )}
    </Card>
  );
}
