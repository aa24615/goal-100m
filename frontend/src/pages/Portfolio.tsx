import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Statistic, Row, Col, Button, Modal, Tag, Segmented, Progress, App, Space, Alert } from 'antd';
import api from '../api';
import { useAuth } from '../auth';
import TradePanel from '../components/TradePanel';
import EquityChart, { type EquityMetric } from '../components/EquityChart';
import type { Portfolio as PF, Holding, EquityResponse } from '../types';
import { formatMoney, formatPct, changeClass } from '../utils';

export default function Portfolio() {
  const navigate = useNavigate();
  const { refreshAssets } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<PF | null>(null);
  const [equity, setEquity] = useState<EquityResponse | null>(null);
  const [days, setDays] = useState<number>(30);
  const [metric, setMetric] = useState<EquityMetric>('total');
  const [sellTarget, setSellTarget] = useState<Holding | null>(null);

  const load = useCallback(() => {
    api.get<PF>('/portfolio').then((r) => setData(r.data));
  }, []);

  const loadEquity = useCallback(async () => {
    try {
      const r = await api.get<EquityResponse>('/equity', { params: { days } });
      // 日级点数不足（开户当天）时，回退到今日分时粒度，保证曲线立刻可用
      if (r.data.series.length < 3) {
        const m = await api.get<EquityResponse>('/equity', { params: { days: 1, gran: 'minute' } });
        setEquity(m.data.series.length >= 2 ? m.data : r.data);
      } else {
        setEquity(r.data);
      }
    } catch {
      /* 曲线加载失败不阻塞页面其余部分 */
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadEquity();
  }, [loadEquity]);

  const onTraded = () => {
    load();
    loadEquity();
    refreshAssets();
    setSellTarget(null);
  };

  const cash = equity?.accounts.cash ?? data?.cash ?? 0;
  const marketValue = equity?.accounts.marketValue ?? data?.marketValue ?? 0;
  const total = equity?.accounts.totalAssets ?? data?.totalAssets ?? 0;
  const cashPct = total > 0 ? (cash / total) * 100 : 0;
  const holdPct = total > 0 ? (marketValue / total) * 100 : 0;

  const columns = [
    { title: '代码', dataIndex: 'code', render: (v: string) => <span className="money">{v}</span> },
    {
      title: '名称',
      dataIndex: 'name',
      render: (v: string, r: Holding) => <a onClick={() => navigate(`/stock/${r.code}`)}>{v}</a>,
    },
    { title: '持仓(股)', dataIndex: 'quantity', align: 'right' as const },
    { title: '成本价', dataIndex: 'avgCost', align: 'right' as const, render: (v: number) => <span className="money">{formatMoney(v)}</span> },
    { title: '现价', dataIndex: 'price', align: 'right' as const, render: (v: number) => <span className="money">{formatMoney(v)}</span> },
    { title: '市值', dataIndex: 'marketValue', align: 'right' as const, render: (v: number) => <span className="money">{formatMoney(v)}</span> },
    {
      title: '盈亏',
      dataIndex: 'pnl',
      align: 'right' as const,
      render: (v: number, r: Holding) => (
        <span className={`money ${changeClass(r.pnl)}`}>
          {formatMoney(v)} ({formatPct(r.pnlPct)})
        </span>
      ),
    },
    {
      title: '操作',
      render: (_: any, r: Holding) => (
        <Button size="small" onClick={() => setSellTarget(r)} style={{ color: '#0d9488', borderColor: '#7fd1cb' }}>
          卖出
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="总资产" value={total} precision={2} prefix="¥" valueStyle={{ fontWeight: 700 }} />
            <div style={{ marginTop: 6, fontSize: 12, color: '#8c8c8c' }}>
              本金 {formatMoney(equity?.initialCapital ?? data?.initialCapital ?? 0)}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card title={<span style={{ fontSize: 13 }}>资金账户</span>} size="small">
            <Statistic value={cash} precision={2} prefix="¥" valueStyle={{ color: '#0d9488', fontWeight: 700 }} />
            <Progress percent={cashPct} showInfo={false} strokeColor="#7fd1cb" size="small" />
            <div style={{ fontSize: 12, color: '#8c8c8c' }}>
              可用现金 · 占总资产 {cashPct.toFixed(1)}%
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card title={<span style={{ fontSize: 13 }}>交易账户</span>} size="small">
            <Statistic value={marketValue} precision={2} prefix="¥" valueStyle={{ color: '#0d9488', fontWeight: 700 }} />
            <Progress percent={holdPct} showInfo={false} strokeColor="#0d9488" size="small" />
            <div style={{ fontSize: 12, color: '#8c8c8c' }}>
              持仓市值 · 占总资产 {holdPct.toFixed(1)}%
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ color: '#8c8c8c', fontSize: 14 }}>总收益率</div>
            <div className={`money ${changeClass(data?.totalPnl ?? 0)}`} style={{ fontSize: 24, fontWeight: 700 }}>
              {formatPct(equity?.summary.returnPct ?? data?.totalPnlPct ?? 0)}
            </div>
            <div className={changeClass(data?.totalPnl ?? 0)}>{formatMoney(equity?.summary.profit ?? data?.totalPnl ?? 0)}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#8c8c8c' }}>
              最大回撤 -{(equity?.summary.maxDrawdown ?? 0).toFixed(2)}%
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        style={{ marginBottom: 16 }}
        title={`资产曲线（${equity?.gran === 'minute' ? '今日分时' : '每日'}）`}
        extra={
          <Space>
            <Segmented
              value={metric}
              onChange={(v) => setMetric(v as EquityMetric)}
              options={[
                { label: '总资产', value: 'total' },
                { label: '收益额', value: 'profit' },
                { label: '收益率', value: 'returnPct' },
              ]}
            />
            <Segmented
              value={days}
              onChange={(v) => setDays(v as number)}
              options={[
                { label: '7天', value: 7 },
                { label: '30天', value: 30 },
                { label: '90天', value: 90 },
                { label: '全部', value: 0 },
              ]}
            />
          </Space>
        }
      >
        {equity && equity.series.length > 1 ? (
          <EquityChart series={equity.series} metric={metric} initialCapital={equity.initialCapital} />
        ) : (
          <Alert
            type="info"
            showIcon
            message="净值曲线正在积累"
            description="系统每分钟记录一次资产快照，每天收盘生成一个净值点。刚开户时只有一个数据点，保持服务运行一段时间后即可看到完整曲线。"
          />
        )}
        <div style={{ marginTop: 8, fontSize: 12, color: '#8c8c8c' }}>
          统计区间 {equity?.range.from ?? '-'} ~ {equity?.range.to ?? '-'}
          {equity?.gran === 'minute' && '（今日分时：每分钟记录一次快照）'} ·
          资金账户（可用现金）+ 交易账户（持仓市值）= 总资产 · 收益率以本金
          {formatMoney(equity?.initialCapital ?? 0)} 为基准
        </div>
      </Card>

      <Card title="当前持仓">
        <Table
          rowKey="code"
          size="middle"
          columns={columns}
          dataSource={data?.holdings ?? []}
          pagination={false}
          locale={{ emptyText: '暂无持仓，去行情中心挑选心仪的标的吧' }}
        />
      </Card>

      <Modal
        title={`卖出 ${sellTarget?.name}（${sellTarget?.code}）`}
        open={!!sellTarget}
        onCancel={() => setSellTarget(null)}
        footer={null}
      >
        {sellTarget && (
          <TradePanel
            code={sellTarget.code}
            mode="SELL"
            initialQuantity={sellTarget.quantity}
            onTraded={onTraded}
          />
        )}
      </Modal>
    </div>
  );
}
