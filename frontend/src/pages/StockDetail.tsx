import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Button, Space, Spin, Tag, App, Empty } from 'antd';
import { ArrowLeftOutlined, StarOutlined, StarFilled } from '@ant-design/icons';
import api from '../api';
import { subscribe } from '../ws';
import StockChart from '../components/StockChart';
import TradePanel from '../components/TradePanel';
import type { StockDetail as Detail, StockQuote } from '../types';
import { formatNum, formatPct, changeClass, formatMoney } from '../utils';

function getWatchlist(): string[] {
  try {
    return JSON.parse(localStorage.getItem('pt_watchlist') || '[]');
  } catch {
    return [];
  }
}

export default function StockDetail() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<{ t: number; p: number }[]>([]);
  const [live, setLive] = useState<StockQuote | undefined>(undefined);
  const [watch, setWatch] = useState<string[]>(getWatchlist());
  const [loading, setLoading] = useState(true);

  const c = code.toUpperCase();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .get<Detail>(`/stocks/${c}`)
      .then((r) => {
        if (!alive) return;
        setDetail(r.data);
        setHistory(r.data.history);
      })
      .catch(() => {
        if (alive) message.error('未找到该股票');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [c, message]);

  useEffect(() => {
    return subscribe((quotes) => {
      const q = quotes.find((x) => x.code === c);
      if (q) {
        setLive(q);
        setHistory((h) => {
          const next = [...h, { t: Date.now(), p: q.price }];
          if (next.length > 300) next.shift();
          return next;
        });
      }
    });
  }, [c]);

  const toggleWatch = () => {
    const set = new Set(watch);
    if (set.has(c)) set.delete(c);
    else set.add(c);
    const arr = Array.from(set);
    setWatch(arr);
    localStorage.setItem('pt_watchlist', JSON.stringify(arr));
  };

  if (loading && !detail) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Empty description="未找到该股票，可能已退市或代码有误" />
      </div>
    );
  }

  const price = live?.price ?? detail?.price ?? 0;
  const prevClose = detail?.prevClose ?? price;
  const change = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  const cls = changeClass(change);
  const chartDetail: Detail = { ...(detail as Detail), history, price, change, changePct };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/market')}>
          返回行情
        </Button>
        <Button
          type="text"
          icon={watch.includes(c) ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
          onClick={toggleWatch}
        >
          {watch.includes(c) ? '已加自选' : '加自选'}
        </Button>
      </Space>

      <Card style={{ marginBottom: 16 }}>
        <Space align="baseline" size="large">
          <span style={{ fontSize: 22, fontWeight: 700 }}>{detail?.name}</span>
          <Tag>{detail?.sector}</Tag>
          <span className="money" style={{ fontSize: 14, color: '#8c8c8c' }}>
            {c}
          </span>
        </Space>
        <div style={{ marginTop: 12 }}>
          <span className={`money ${cls}`} style={{ fontSize: 36, fontWeight: 700 }}>
            {formatNum(price)}
          </span>
          <span className={`money ${cls}`} style={{ fontSize: 18, marginLeft: 16 }}>
            {formatNum(change)} {formatPct(changePct)}
          </span>
        </div>
        <Descriptions size="small" column={4} style={{ marginTop: 12 }}>
          <Descriptions.Item label="今开">{formatNum(detail?.open ?? price)}</Descriptions.Item>
          <Descriptions.Item label="昨收">{formatNum(prevClose)}</Descriptions.Item>
          <Descriptions.Item label="最高">{formatNum(detail?.high ?? price)}</Descriptions.Item>
          <Descriptions.Item label="最低">{formatNum(detail?.low ?? price)}</Descriptions.Item>
          <Descriptions.Item label="成交量(股)">{(detail?.volume ?? 0).toLocaleString('zh-CN')}</Descriptions.Item>
        </Descriptions>
      </Card>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Card title="分时走势" style={{ flex: '1 1 600px', minWidth: 480 }}>
          <StockChart detail={chartDetail} />
        </Card>
        <Card title="交易" style={{ flex: '1 1 320px', minWidth: 300 }}>
          <TradePanel code={c} onTraded={() => message.success('持仓已更新')} />
        </Card>
      </div>
    </div>
  );
}
