import React, { useCallback, useEffect, useState } from 'react';
import { Table, Tag, Button, Card, Space, App, Empty, InputNumber, Popconfirm, Alert } from 'antd';
import api, { getOrders, cancelOrder } from '../api';
import type { Order } from '../types';
import { formatNum } from '../utils';
import Disclaimer from '../components/Disclaimer';

const STATUS_META: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'blue', text: '等待成交' },
  FILLED: { color: 'green', text: '已成交' },
  CANCELLED: { color: 'default', text: '已撤单' },
};

// 委托管理页（RQ-26）：此前限价委托提交后无处查看、无法撤单，只能靠猜。
export default function Orders() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<string>('');
  const [rows, setRows] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getOrders(status || undefined);
      setRows(r.data);
    } catch {
      message.error('加载委托失败');
    } finally {
      setLoading(false);
    }
  }, [status, message]);

  useEffect(() => {
    load();
    // 委托状态随行情撮合变化，页面可见时轮询刷新（5 秒内可见变化）
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [load]);

  const onCancel = async (id: number) => {
    try {
      await api.delete(`/orders/${id}`);
      message.success('已撤单，冻结资金/持仓已释放');
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error || '撤单失败');
    }
  };

  return (
    <div>
      <Disclaimer />
      <Card
        title="我的委托"
        extra={
          <Space>
            <Button size="small" onClick={load}>
              刷新
            </Button>
            <Button size="small" type={status === '' ? 'primary' : 'default'} onClick={() => setStatus('')}>
              全部
            </Button>
            <Button size="small" type={status === 'PENDING' ? 'primary' : 'default'} onClick={() => setStatus('PENDING')}>
              仅未成交
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12, fontSize: 12 }}
          message="限价委托在行情达到条件时自动撮合；撤单后占用的资金或持仓会立即释放。"
        />
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          locale={{ emptyText: <Empty description="暂无委托记录" /> }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '标的', render: (_: unknown, r: Order) => `${r.name} ${r.code}` },
            {
              title: '方向',
              dataIndex: 'side',
              render: (v: string) => <Tag color={v === 'BUY' ? 'red' : 'green'}>{v === 'BUY' ? '买入' : '卖出'}</Tag>,
            },
            { title: '委托价', dataIndex: 'limitPrice', render: (v: number) => formatNum(v) },
            { title: '数量', dataIndex: 'quantity' },
            {
              title: '状态',
              dataIndex: 'status',
              render: (v: string) => <Tag color={STATUS_META[v]?.color}>{STATUS_META[v]?.text || v}</Tag>,
            },
            { title: '成交价', dataIndex: 'filledPrice', render: (v: number | null) => (v == null ? '-' : formatNum(v)) },
            { title: '备注', dataIndex: 'note', render: (v: string | null) => v || '-' },
            {
              title: '操作',
              render: (_: unknown, r: Order) =>
                r.status === 'PENDING' ? (
                  <Popconfirm title="确认撤销该委托？" onConfirm={() => onCancel(r.id)}>
                    <Button size="small" danger data-testid={`cancel-${r.id}`}>
                      撤单
                    </Button>
                  </Popconfirm>
                ) : (
                  '-'
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
