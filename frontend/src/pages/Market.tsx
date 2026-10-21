import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Input, Select, Tag, Button, Space, Card, Statistic, Row, Col, Empty } from 'antd';
import { StarOutlined, StarFilled, SearchOutlined } from '@ant-design/icons';
import { subscribe } from '../ws';
import { useWatchlist } from '../useWatchlist';
import type { StockQuote } from '../types';
import { formatNum, formatPct, changeClass, formatMoney } from '../utils';

export default function Market() {
  const navigate = useNavigate();
  const { watch, toggle } = useWatchlist();
  const [quotes, setQuotes] = useState<StockQuote[]>([]);
  const [keyword, setKeyword] = useState('');
  const [sector, setSector] = useState<string>('全部');

  useEffect(() => {
    return subscribe(setQuotes);
  }, []);

  const sectors = useMemo(() => ['全部', ...Array.from(new Set(quotes.map((q) => q.sector)))], [quotes]);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return quotes.filter((q) => {
      if (sector !== '全部' && q.sector !== sector) return false;
      if (k && !q.code.toLowerCase().includes(k) && !q.name.toLowerCase().includes(k)) return false;
      return true;
    });
  }, [quotes, keyword, sector]);

  const summary = useMemo(() => {
    let up = 0;
    let down = 0;
    let flat = 0;
    let idx = 0;
    let base = 0;
    for (const q of quotes) {
      if (q.change > 0) up += 1;
      else if (q.change < 0) down += 1;
      else flat += 1;
      idx += q.price;
      base += q.prevClose;
    }
    const total = quotes.length || 1;
    return { up, down, flat, indexValue: idx / total, indexPct: base ? ((idx - base) / base) * 100 : 0 };
  }, [quotes]);

  // 自选股读写走后端接口（useWatchlist 内已做本地兜底）

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
          <Card style={{ height: '100%' }}>
            <Statistic
              title="模拟大盘"
              value={formatNum(summary.indexValue)}
              precision={2}
              suffix={
                <span className={changeClass(summary.indexPct)} style={{ fontSize: 13, marginLeft: 6 }}>
                  {formatPct(summary.indexPct)}
                </span>
              }
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Statistic title="上涨" value={summary.up} valueStyle={{ color: '#e0584f' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Statistic title="下跌" value={summary.down} valueStyle={{ color: '#2fa06a' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Statistic title="平盘" value={summary.flat} valueStyle={{ color: '#8c8c8c' }} />
          </Card>
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
          <Select value={sector} onChange={setSector} style={{ width: 160 }} options={sectors.map((s) => ({ label: s, value: s }))} />
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
