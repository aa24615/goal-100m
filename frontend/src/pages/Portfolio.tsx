import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Statistic, Row, Col, Button, Modal, Tag, App } from 'antd';
import api from '../api';
import { useAuth } from '../auth';
import TradePanel from '../components/TradePanel';
import type { Portfolio as PF, Holding } from '../types';
import { formatMoney, formatPct, changeClass } from '../utils';

export default function Portfolio() {
  const navigate = useNavigate();
  const { refreshAssets } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<PF | null>(null);
  const [sellTarget, setSellTarget] = useState<Holding | null>(null);

  const load = useCallback(() => {
    api.get<PF>('/portfolio').then((r) => setData(r.data));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onTraded = () => {
    load();
    refreshAssets();
    setSellTarget(null);
  };

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
            <Statistic title="总资产" value={data?.totalAssets ?? 0} precision={2} prefix="¥" valueStyle={{ fontWeight: 700 }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="可用资金" value={data?.cash ?? 0} precision={2} prefix="¥" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="持仓市值" value={data?.marketValue ?? 0} precision={2} prefix="¥" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <div style={{ color: '#8c8c8c', fontSize: 14 }}>总收益率</div>
            <div className={`money ${changeClass(data?.totalPnl ?? 0)}`} style={{ fontSize: 24, fontWeight: 700 }}>
              {formatPct(data?.totalPnlPct ?? 0)}
            </div>
            <div className={changeClass(data?.totalPnl ?? 0)}>{formatMoney(data?.totalPnl ?? 0)}</div>
          </Card>
        </Col>
      </Row>

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
