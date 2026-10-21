import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Input, Select, Tag, Button, Space, Row, Col, Card, Empty } from 'antd';
import { StarOutlined, StarFilled, SearchOutlined } from '@ant-design/icons';
import { useWatchlist } from '../hooks/useWatchlist';
import { useMarket } from '../hooks/useMarket';
import StatCard from '../components/StatCard';
import type { StockQuote } from '../types';
import { formatNum, formatPct, changeClass } from '../utils';

export default function Market() {
  const navigate = useNavigate();
  const { watch, toggle } = useWatchlist();
  const { quotes, sectors, summary } = useMarket();
  const [keyword, setKeyword] = useState('');
  const [sector, setSector] = useState<string>('全部');

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return quotes.filter((q) => {
      if (sector !== '全部' && q.sector !== sector) return false;
      if (k && !q.code.toLowerCase().includes(k) && !q.name.toLowerCase().includes(k)) return false;
      return true;
    });
  }, [quotes, keyword, sector]);

  const columns = [
    {
      title: '代码',
      dataIndex: 'code',
      width: 90,
      render: (code: string) => <span className="money">{code}</span>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      render: (name: string, r: StockQuote) => (
        <Space>
          <a onClick={() => navigate(`/stock/${r.code}`)}>{name}</a>
          <Tag color="default">{r.sector}</Tag>
        </Space>
      ),
    },
    {
      title: '最新价',
      dataIndex: 'price',
      align: 'right' as const,
      sorter: (a: StockQuote, b: StockQuote) => a.price - b.price,
      render: (p: number, r: StockQuote) => (
        <span className={`money ${changeClass(r.change)}`}>{formatNum(p)}</span>
      ),
    },
    {
      title: '涨跌幅',
      dataIndex: 'changePct',
      align: 'right' as const,
      sorter: (a: StockQuote, b: StockQuote) => a.changePct - b.changePct,
      defaultSortOrder: 'descend' as const,
      render: (v: number, r: StockQuote) => (
        <span className={`money ${changeClass(r.change)}`}>{formatPct(v)}</span>
      ),
    },
    { title: '涨跌额', dataIndex: 'change', align: 'right' as const, render: (v: number, r: StockQuote) => <span className={`money ${changeClass(r.change)}`}>{formatNum(v)}</span> },
    { title: '最高', dataIndex: 'high', align: 'right' as const, render: (v: number) => <span className="money">{formatNum(v)}</span> },
    { title: '最低', dataIndex: 'low', align: 'right' as const, render: (v: number) => <span className="money">{formatNum(v)}</span> },
    {
      title: '成交量(股)',
      dataIndex: 'volume',
      align: 'right' as const,
      sorter: (a: StockQuote, b: StockQuote) => a.volume - b.volume,
      render: (v: number) => <span className="money">{v.toLocaleString('zh-CN')}</span>,
    },
    {
      title: '操作',
      width: 80,
      render: (_: any, r: StockQuote) => (
        <Button
          type="text"
          icon={watch.includes(r.code) ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            toggle(r.code);
          }}
        />
      ),
    },
  ];

  return (
    <div>
      <Row gutter={16} align="stretch" style={{ marginBottom: 16 }}>
        <Col span={6}>
          <StatCard
            title="模拟大盘"
            value={formatNum(summary.indexValue)}
            suffix={
              <span className={changeClass(summary.indexPct)} style={{ fontSize: 13, marginLeft: 6 }}>
                {formatPct(summary.indexPct)}
              </span>
            }
          />
        </Col>
        <Col span={6}>
          <StatCard title="上涨" value={summary.up} valueColor="#e0584f" />
        </Col>
        <Col span={6}>
          <StatCard title="下跌" value={summary.down} valueColor="#2fa06a" />
        </Col>
        <Col span={6}>
          <StatCard title="平盘" value={summary.flat} valueColor="#8c8c8c" />
        </Col>
      </Row>

      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索代码 / 名称"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 220 }}
          />
          <Select
            value={sector}
            onChange={setSector}
            style={{ width: 160 }}
            options={sectors.map((s) => ({ label: s, value: s }))}
          />
        </Space>
        <Table
          rowKey="code"
          size="middle"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 15, showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => navigate(`/stock/${r.code}`) })}
          locale={{ emptyText: <Empty description="暂无数据" /> }}
        />
      </Card>
    </div>
  );
}
