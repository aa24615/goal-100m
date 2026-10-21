import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Select, Button, Empty, Tag, Space } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { subscribe } from '../ws';
import { useWatchlist } from '../hooks/useWatchlist';
import type { StockQuote } from '../types';
import { formatNum, formatPct, changeClass } from '../utils';

export default function Watchlist() {
  const navigate = useNavigate();
  const { watch, add, remove } = useWatchlist();
  const [quotes, setQuotes] = useState<StockQuote[]>([]);

  useEffect(() => {
    return subscribe(setQuotes);
  }, []);

  const watched = useMemo(
    () => quotes.filter((q) => watch.includes(q.code)),
    [quotes, watch]
  );

  const allOptions = useMemo(
    () => quotes.map((q) => ({ label: `${q.code} ${q.name}`, value: q.code })),
    [quotes]
  );

  // 自选股读写走后端接口（useWatchlist 内已做本地兜底）

  const columns = [
    { title: '代码', dataIndex: 'code', render: (v: string) => <span className="money">{v}</span> },
    { title: '名称', dataIndex: 'name', render: (v: string, r: StockQuote) => <a onClick={() => navigate(`/stock/${r.code}`)}>{v}</a> },
    { title: '最新价', dataIndex: 'price', align: 'right' as const, render: (v: number, r: StockQuote) => <span className={`money ${changeClass(r.change)}`}>{formatNum(v)}</span> },
    { title: '涨跌幅', dataIndex: 'changePct', align: 'right' as const, render: (v: number, r: StockQuote) => <span className={`money ${changeClass(r.change)}`}>{formatPct(v)}</span> },
    { title: '最高', dataIndex: 'high', align: 'right' as const, render: (v: number) => <span className="money">{formatNum(v)}</span> },
    { title: '最低', dataIndex: 'low', align: 'right' as const, render: (v: number) => <span className="money">{formatNum(v)}</span> },
    {
      title: '操作',
      render: (_: any, r: StockQuote) => (
        <Button type="text" icon={<DeleteOutlined />} onClick={() => remove(r.code)} style={{ color: '#8c8c8c' }}>
          移除
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="我的自选"
      extra={
        <Select
          showSearch
          placeholder="添加自选股"
          style={{ width: 220 }}
          value={null}
          options={allOptions}
          onChange={add}
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      }
    >
      {watched.length === 0 ? (
        <Empty description="还没有自选股，去行情中心点击☆添加吧" />
      ) : (
        <Table rowKey="code" size="middle" columns={columns} dataSource={watched} pagination={false} />
      )}
    </Card>
  );
}
