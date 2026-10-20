import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Empty } from 'antd';
import api from '../api';
import type { Transaction } from '../types';
import { formatMoney, formatNum } from '../utils';

export default function Transactions() {
  const [items, setItems] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = (p: number) => {
    setLoading(true);
    api
      .get('/transactions', { params: { page: p, size: 15 } })
      .then((r) => {
        setItems(r.data.items);
        setTotal(r.data.total);
        setPage(p);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(1);
  }, []);

  const columns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    { title: '代码', dataIndex: 'stockCode', render: (v: string) => <span className="money">{v}</span> },
    { title: '名称', dataIndex: 'stockName' },
    {
      title: '方向',
      dataIndex: 'type',
      render: (t: string) =>
        t === 'BUY' ? (
          <Tag style={{ color: '#e0584f', background: '#fdf1f0', border: 'none' }}>买入</Tag>
        ) : (
          <Tag style={{ color: '#2fa06a', background: '#edfaf3', border: 'none' }}>卖出</Tag>
        ),
    },
    { title: '数量', dataIndex: 'quantity', align: 'right' as const },
    { title: '价格', dataIndex: 'price', align: 'right' as const, render: (v: number) => <span className="money">{formatNum(v)}</span> },
    { title: '金额', dataIndex: 'amount', align: 'right' as const, render: (v: number) => <span className="money">{formatMoney(v)}</span> },
    { title: '手续费', dataIndex: 'fee', align: 'right' as const, render: (v: number) => <span className="money">{formatMoney(v)}</span> },
  ];

  return (
    <Card title="交易记录">
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{
          current: page,
          total,
          pageSize: 15,
          showSizeChanger: false,
          onChange: load,
        }}
        locale={{ emptyText: <Empty description="还没有交易记录" /> }}
      />
    </Card>
  );
}
