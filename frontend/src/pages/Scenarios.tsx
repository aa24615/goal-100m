import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, InputNumber, Modal, Row, Space, Statistic, Table, Tag, App, Progress, Descriptions } from 'antd';
import { listScenarios, getScenarioBars, submitScenario } from '../api';
import type { Scenario, ScenarioBars, ScenarioResult } from '../types';
import { DIFFICULTY_COLOR } from '../constants';
import { formatMoney, formatNum } from '../utils';
import Disclaimer from '../components/Disclaimer';

// 剧本训练场（RQ-16 ~ RQ-19）
// 客户端只负责「按已确定的剧本行情做操作」，评分由服务端用同一引擎重算 —— 防刷分、可复查。
export default function Scenarios() {
  const { message } = App.useApp();
  const [list, setList] = useState<Scenario[]>([]);
  const [active, setActive] = useState<ScenarioBars | null>(null);
  const [cursor, setCursor] = useState(1);
  const [trades, setTrades] = useState<{ seq: number; side: 'BUY' | 'SELL'; quantity: number }[]>([]);
  const [qty, setQty] = useState(1000);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    listScenarios().then((r) => setList(r.data)).catch(() => setList([]));
  }, []);

  const open = async (key: string) => {
    try {
      const r = await getScenarioBars(key);
      setActive(r.data);
      setCursor(1);
      setTrades([]);
      setResult(null);
      setLeft(r.data.constraints.maxTrades);
    } catch {
      message.error('加载剧本失败');
    }
  };

  const current = active?.series.find((s) => s.seq === cursor);
  const totalBars = active?.series.length ?? 0;

  // 简易持仓：用于界面提示，真实核算在服务端
  const holding = trades.reduce((acc, t) => acc + (t.side === 'BUY' ? t.quantity : -t.quantity), 0);

  const act = (side: 'BUY' | 'SELL') => {
    if (!active) return;
    if (left <= 0) {
      message.warning(`本关最多 ${active.constraints.maxTrades} 次交易`);
      return;
    }
    if (side === 'SELL' && holding < qty) {
      message.warning(`当前持仓 ${holding} 股，不足 ${qty} 股`);
      return;
    }
    setTrades((t) => [...t, { seq: cursor, side, quantity: qty }]);
    setLeft((n) => n - 1);
  };

  const submit = async () => {
    if (!active) return;
    try {
      const r = await submitScenario(active.key, trades);
      setResult(r.data);
      const l = await listScenarios();
      setList(l.data);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '提交失败');
    }
  };

  if (active) {
    return (
      <div>
        <Disclaimer text="本场景为虚构行情，仅用于训练，不构成任何投资建议" />
        <Card
          title={`${active.name}（第 ${cursor} / ${totalBars} 根 K 线）`}
          extra={
            <Space>
              <Button onClick={() => setActive(null)}>返回关卡列表</Button>
              <Button type="primary" onClick={submit} disabled={trades.length === 0} data-testid="scenario-submit">
                提交并评分
              </Button>
            </Space>
          }
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12, fontSize: 12 }}
            message={`训练目标：${active.goal}｜初始资金 ${formatMoney(active.constraints.initialCapital)}｜最多 ${active.constraints.maxTrades} 次交易（剩余 ${left}）｜回撤上限 ${active.constraints.maxDrawdownPct}%`}
          />
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={8}>
              <Statistic title="当前价" value={current?.close ?? 0} precision={2} />
            </Col>
            <Col span={8}>
              <Statistic title="当前持仓" value={holding} suffix="股" />
            </Col>
            <Col span={8}>
              <Statistic title="已操作" value={trades.length} suffix="次" />
            </Col>
          </Row>
          <Space wrap style={{ marginBottom: 12 }}>
            <Button disabled={cursor <= 1} onClick={() => setCursor((c) => c - 1)}>
              上一根
            </Button>
            <Button type="primary" disabled={cursor >= totalBars} onClick={() => setCursor((c) => c + 1)} data-testid="scenario-next">
              下一根
            </Button>
            <Button disabled={cursor >= totalBars} onClick={() => setCursor(totalBars)}>
              跳到结束
            </Button>
          </Space>
          <Space wrap style={{ marginBottom: 12 }}>
            <InputNumber min={100} step={100} value={qty} onChange={(v) => setQty(Number(v) || 100)} addonAfter="股" />
            <Button danger onClick={() => act('BUY')} disabled={left <= 0} data-testid="scenario-buy">
              买入
            </Button>
            <Button onClick={() => act('SELL')} disabled={left <= 0 || holding < qty} data-testid="scenario-sell">
              卖出
            </Button>
          </Space>
          <Table
            size="small"
            rowKey={(r, i) => `${r.seq}-${r.side}-${i}`}
            dataSource={trades}
            locale={{ emptyText: '尚未操作' }}
            pagination={{ pageSize: 6 }}
            columns={[
              { title: '第几根', dataIndex: 'seq' },
              { title: '方向', dataIndex: 'side', render: (v: string) => <Tag color={v === 'BUY' ? 'red' : 'green'}>{v === 'BUY' ? '买入' : '卖出'}</Tag> },
              { title: '数量', dataIndex: 'quantity' },
              {
                title: '参考价',
                render: (_: unknown, r) => formatNum(active.series.find((s) => s.seq === r.seq)?.close ?? 0),
              },
            ]}
          />
        </Card>

        <Modal open={!!result} title="关卡评分" width={640} footer={null} onCancel={() => setResult(null)}>
          {result && (
            <>
              <Row gutter={12}>
                <Col span={8}>
                  <Statistic title="总分" value={result.score.total} suffix={`/ ${result.score.grade}`} />
                </Col>
                <Col span={8}>
                  <Statistic title="收益率" value={result.metrics.returnPct} precision={2} suffix="%" />
                </Col>
                <Col span={8}>
                  <Statistic title="最大回撤" value={result.metrics.maxDrawdown} precision={2} suffix="%" />
                </Col>
              </Row>
              <Tag color={result.score.passed ? 'green' : 'red'} style={{ marginTop: 8 }}>
                {result.score.passed ? '通关' : '未通关'}
              </Tag>
              <Descriptions column={2} size="small" bordered style={{ marginTop: 12 }}>
                <Descriptions.Item label="收益分">{result.score.breakdown.returnScore}</Descriptions.Item>
                <Descriptions.Item label="回撤分">{result.score.breakdown.drawdownScore}</Descriptions.Item>
                <Descriptions.Item label="纪律分">{result.score.breakdown.disciplineScore}</Descriptions.Item>
                <Descriptions.Item label="决策质量分">{result.score.breakdown.decisionScore}</Descriptions.Item>
              </Descriptions>
              {result.score.violations.length > 0 && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="违规项"
                  description={result.score.violations.map((v) => v.detail).join('；')}
                />
              )}
              <Descriptions title="关键节点提示" column={1} size="small" style={{ marginTop: 12 }}>
                {result.hints.map((h, i) => (
                  <Descriptions.Item key={i} label={h.node}>
                    {h.detail}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </>
          )}
        </Modal>
      </div>
    );
  }

  return (
    <div>
      <Disclaimer text="以下剧本为虚构行情，仅用于交易训练，不构成任何投资建议" />
      <Table
        rowKey="key"
        dataSource={list}
        locale={{ emptyText: <Empty description="题库加载中" /> }}
        pagination={false}
        columns={[
          {
            title: '关卡',
            dataIndex: 'name',
            render: (v: string, r: Scenario) => (
              <Space direction="vertical" size={0}>
                <b>{v}</b>
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>{r.brief}</span>
              </Space>
            ),
          },
          {
            title: '难度',
            dataIndex: 'difficulty',
            width: 90,
            render: (v: string) => (
              <Tag color={DIFFICULTY_COLOR[v]}>
                {v === 'easy' ? '入门' : v === 'medium' ? '进阶' : '困难'}
              </Tag>
            ),
          },
          {
            title: '训练目标',
            dataIndex: 'goal',
            render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span>,
          },
          {
            title: '最佳成绩',
            width: 140,
            render: (_: unknown, r: Scenario) =>
              r.attempts === 0 ? (
                <span style={{ color: '#bfbfbf' }}>未挑战</span>
              ) : (
                <Space direction="vertical" size={0}>
                  <Tag color={r.bestScore !== null && r.bestScore >= 60 ? 'green' : 'orange'}>{r.bestScore} 分</Tag>
                  <span style={{ fontSize: 11, color: '#8c8c8c' }}>已挑战 {r.attempts} 次</span>
                </Space>
              ),
          },
          {
            title: '操作',
            width: 100,
            render: (_: unknown, r: Scenario) => (
              <Button type="primary" size="small" onClick={() => open(r.key)} data-testid={`open-${r.key}`}>
                开始
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
