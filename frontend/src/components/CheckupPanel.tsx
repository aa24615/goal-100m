/**
 * 交易体检单面板（RQ-76 五项决定论指标 / RQ-77 样本门槛 / RQ-78 拆解与提示）
 *
 * 两条硬约束直接体现在 UI 上：
 * 1. **样本 < 50 笔不输出任何结论性判断** —— 不评级、不打标签，
 *    只显示「还差 N 笔」+ 进度条 + 原始流水（RQ-77）。空面板正是该功能的价值所在。
 * 2. **每项指标必须带一行口径说明** —— 「这个数说明什么 / 什么时候该改」，
 *    口径来自后端 METRIC_HINTS，前端不做二次改写（RQ-78）。
 */

import React, { useMemo, useState } from 'react';
import { Card, Progress, Statistic, Tag, Typography, Alert, Space, Tooltip, Table, Divider, Empty, Button } from 'antd';
import { InfoCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { CheckupPayload, BreakdownGroup, MetricHint } from '../types';
import { formatMoney, formatNum } from '../utils';
import { RATIO_GUARD_THRESHOLD } from '../constants';

const { Text, Paragraph, Title } = Typography;

/** RQ-80 达标提示「出现一次且可关闭」：关闭状态存本地，不污染服务端数据 */
const MILESTONE_DISMISS_KEY = 'mm8888.checkup.milestone.dismissed';

function milestoneDismissed(key: string) {
  try {
    const raw = window.localStorage.getItem(MILESTONE_DISMISS_KEY);
    if (!raw) return false;
    return JSON.parse(raw).includes(key);
  } catch {
    return false;
  }
}

function dismissMilestone(key: string) {
  try {
    const raw = window.localStorage.getItem(MILESTONE_DISMISS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return;
    if (!list.includes(key)) list.push(key);
    window.localStorage.setItem(MILESTONE_DISMISS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage 不可用（隐私模式）时静默降级：提示会重复出现，但不影响功能 */
  }
}

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

/**
 * 本组件刻意**不直接持有路由与网络**：导航与开训交给父页面注入回调。
 * 原因：体检单是纯展示组件，一旦内部调用 useNavigate，任何脱离 <Router> 的渲染
 * （单测、分享卡片、导出快照）都会直接抛 invariant。留在这里的是展示，出去的是副作用。
 */
export interface CheckupPanelProps {
  data: CheckupPayload | null;
  loading?: boolean;
  /** RQ-85 冷启动引导的「去做第一段盲测」点击 */
  onStartTraining?: (path: string) => void;
  /** RQ-83 「就练这个」：由父页面调用处方接口并跳转到新会话 */
  onStartPrescription?: (checkup: CheckupPayload) => void | Promise<void>;
}

export default function CheckupPanel({ data, loading, onStartTraining, onStartPrescription }: CheckupPanelProps) {
  const [prescribing, setPrescribing] = useState(false);
  const [showMilestone, setShowMilestone] = useState(true);

  // RQ-79 分档：后端未返回 tier（旧版/单测 mock）时退化为「够 / 不够」两态，不崩
  const tier = data?.tier ?? null;
  const progress = data?.progress ?? null;
  const sampleSize = Number(data?.sampleSize ?? 0);

  const milestone = useMemo(() => {
    if (!data?.milestone?.justReached) return null;
    const key = String(data.milestone.tierKey || '');
    if (!key) return null;
    return showMilestone && !milestoneDismissed(key) ? data.milestone : null;
  }, [data, showMilestone]);

  // RQ-95 小样本护栏：以后端 ratioGate 为准，缺失时按本地阈值兜底（前后端同源）
  const showRatios = data?.ratioGate ? data.ratioGate.showRatios : sampleSize >= RATIO_GUARD_THRESHOLD;

  // 进度条口径优先用后端 progress（已按「当前档→下一档」区间计算），
  // 缺失时退回旧算法，保证向后兼容
  const percent = progress
    ? progress.percent
    : Math.min(100, Math.round((sampleSize / Math.max(1, Number(data?.threshold || 50))) * 100));

  /** RQ-83 从体检单「最坏习惯」一键开训（副作用在父页面） */
  const startPrescription = async () => {
    if (!data || !onStartPrescription) return;
    setPrescribing(true);
    try {
      await onStartPrescription(data);
    } finally {
      setPrescribing(false);
    }
  };

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
                percent={percent}
                size="small"
                status={data.sufficient ? 'success' : 'active'}
              />
            }
          />

          {/* RQ-79 可信度分档：明示「能信什么 / 还不能拿它做什么」 */}
          {tier && (
            <div data-testid="checkup-tier" style={{ marginBottom: 12 }}>
              <Space wrap size={8} style={{ marginBottom: 6 }}>
                <Tag color={tier.key === 'none' ? 'default' : tier.key === 'strategy' ? 'green' : 'blue'}>
                  当前可信度：{tier.label}
                </Tag>
                {tier.next && <Text type="secondary" style={{ fontSize: 12 }}>{progress?.text || ''}</Text>}
                {tier.reachedTop && <Text type="secondary" style={{ fontSize: 12 }}>已达最高档</Text>}
              </Space>
              <div style={{ fontSize: 12 }}>
                <div>
                  <Text type="secondary">能信：</Text>
                  {tier.canTrust?.length > 0 ? tier.canTrust.join('；') : '暂时什么都还不能下结论'}
                </div>
                <div>
                  <Text type="secondary">还不能拿它做：</Text>
                  {tier.cannotTrust?.length > 0 ? tier.cannotTrust.join('；') : '—'}
                </div>
              </div>
            </div>
          )}

          {/* RQ-97 误差带：把统计不确定性直接写进界面（本次检索中唯一确认的全行业空白） */}
          {data.errorBand && (
            <div data-testid="checkup-error-band" style={{ marginBottom: 12, fontSize: 12 }}>
              <Text type="secondary">期望值误差带：</Text>
              <div>{data.errorBand.text}</div>
              <div style={{ marginTop: 2 }}>{data.errorBand.cannot}</div>
            </div>
          )}

          {/* RQ-95 小样本护栏：N < 30 不展示任何比率类结论 */}
          {!showRatios && (
            <Alert
              type="info"
              showIcon={false}
              style={{ marginBottom: 12, fontSize: 12 }}
              data-testid="checkup-ratio-gate"
              message={
                data.ratioGate?.reason ||
                `样本 ${sampleSize} 笔未达 ${RATIO_GUARD_THRESHOLD} 笔护栏，胜率 / 期望值（R）/ 平均 R 与排名暂不展示。`
              }
            />
          )}

          {/* RQ-80 距下一档的进度条 */}
          {progress && !progress.reachedTop && (
            <div data-testid="checkup-progress" style={{ marginBottom: 12 }}>
              <Progress
                percent={progress.percent}
                size="small"
                format={() => progress.text}
                status="active"
              />
            </div>
          )}

          {/* RQ-80 达标当日提示：出现一次，可关闭 */}
          {milestone && (
            <Alert
              type="success"
              showIcon
              closable
              style={{ marginBottom: 12 }}
              data-testid="checkup-milestone"
              message={milestone.message}
              description={milestone.cannot}
              onClose={() => {
                dismissMilestone(String(milestone.tierKey || ''));
                setShowMilestone(false);
              }}
            />
          )}

          {/* RQ-85 冷启动：0 笔不给空面板，给「先做 3 段盲测」的具体动作 */}
          {data.coldStart?.isCold && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="checkup-cold-start"
              message={data.coldStart.title}
              description={
                <div>
                  <ol style={{ paddingLeft: 18, margin: '6px 0' }}>
                    {(data.coldStart.steps || []).map((s) => (
                      <li key={s} style={{ fontSize: 12 }}>
                        {s}
                      </li>
                    ))}
                  </ol>
                  <Button
                    type="primary"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    data-testid="cold-start-go"
                    onClick={() => onStartTraining?.(data.coldStart?.action?.path || '/blind')}
                  >
                    {data.coldStart.action?.label || '去做第一段盲测'}
                  </Button>
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    <Text type="secondary">{data.coldStart.note}</Text>
                  </div>
                </div>
              }
            />
          )}

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
            {/* RQ-95：以下三项是**比率类**指标，样本未过护栏时整块不渲染 */}
            {showRatios && (
              <div data-testid="ratio-metrics" style={{ display: 'contents' }}>
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
              </div>
            )}
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
              description={
                <div>
                  <div>{data.worstHabit.detail}</div>
                  {/* RQ-83 训练处方：体检 → 训练闭环的入口，竞品全无这一段 */}
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      先改这一项，比同时改五项更容易见效。
                    </Text>
                    <Button
                      type="primary"
                      size="small"
                      style={{ marginLeft: 8 }}
                      loading={prescribing}
                      data-testid="prescription-start"
                      onClick={startPrescription}
                    >
                      就练这个
                    </Button>
                  </div>
                </div>
              }
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
