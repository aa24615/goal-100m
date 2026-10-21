import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Empty, Segmented, Typography } from 'antd';
import api from '../api';
import type { LeaderRow } from '../types';
import { formatMoney, formatPct, changeClass } from '../utils';

const { Text } = Typography;

const PERIODS = [
  { label: '周榜', value: 'week', base: '本周初' },
  { label: '月榜', value: 'month', base: '本月初' },
  { label: '季榜', value: 'quarter', base: '本季初' },
  { label: '年榜', value: 'year', base: '年初' },
  { label: '总榜', value: 'all', base: '初始' },
];

const rankColor = (rank: number) => {
  if (rank === 1) return '#f5b50a';
  if (rank === 2) return '#a0a0a0';
  if (rank === 3) return '#cd7f32';
  return undefined;
};

export default function Leaderboard() {
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<string>('all');
  const [benchmarkPct, setBenchmarkPct] = useState<number>(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<LeaderRow[]>('/leaderboard', { params: { period } }),
      api.get<{ benchmarkPct: number }>('/leaderboard/benchmark', { params: { period } }),
    ])
      .then(([r, b]) => {
        setRows(r.data);
        setBenchmarkPct(b.data?.benchmarkPct ?? 0);
      })
      .finally(() => setLoading(false));
  }, [period]);

  const meta = PERIODS.find((p) => p.value === period) || PERIODS[4];

  const columns = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 80,
      render: (rank: number) =>
        rank <= 3 ? (
          <Tag color={rankColor(rank)} style={{ fontSize: 14, fontWeight: 700 }}>
            NO.{rank}
          </Tag>
        ) : (
          <span style={{ color: '#8c8c8c' }}>{rank}</span>
        ),
    },
    { title: '选手', dataIndex: 'username' },
    {
      title: '总资产',
      dataIndex: 'totalAssets',
      align: 'right' as const,
      sorter: (a: LeaderRow, b: LeaderRow) => a.totalAssets - b.totalAssets,
      render: (v: number) => <span className="money">{formatMoney(v)}</span>,
    },
    {
      title: '持仓市值',
      dataIndex: 'marketValue',
      align: 'right' as const,
      render: (v: number) => <span className="money">{formatMoney(v)}</span>,
    },
    {
      title: `${meta.base}资产`,
      dataIndex: 'baseAssets',
      align: 'right' as const,
      render: (v: number) => (
        <span className="money" style={{ color: '#8c8c8c' }}>
          {formatMoney(v)}
        </span>
      ),
    },
    {
      title: `${meta.label}收益率`,
      dataIndex: 'returnPct',
      align: 'right' as const,
      defaultSortOrder: 'descend' as const,
      sorter: (a: LeaderRow, b: LeaderRow) => a.returnPct - b.returnPct,
      render: (v: number) => (
        <span className={`money ${changeClass(v)}`} style={{ fontWeight: 700 }}>
          {formatPct(v)}
        </span>
      ),
    },
    {
      title: '超越大盘',
      dataIndex: 'excessPct',
      align: 'right' as const,
      sorter: (a: LeaderRow, b: LeaderRow) => a.excessPct - b.excessPct,
      render: (v: number) => (
        <span className={`money ${changeClass(v)}`}>{v === undefined ? '-' : formatPct(v)}</span>
      ),
    },
    {
      title: '交易次数',
      dataIndex: 'tradeCount',
      align: 'right' as const,
      render: (v: number) => <span style={{ color: v ? undefined : '#bfbfbf' }}>{v ?? 0}</span>,
    },
  ];

  return (
    <Card
      title={`收益排行榜 · ${meta.label}`}
      extra={<Segmented value={period} onChange={(v) => setPeriod(String(v))} options={PERIODS.map(p => ({label: p.label, value: p.value}))} />}
    >
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无选手" /> }}
      />
      <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
        周期收益率 =（当前总资产 − {meta.base}资产）÷ {meta.base}资产；
        「超越大盘」= 个人收益率 − 同期大盘指数涨跌幅（当前大盘 {formatPct(benchmarkPct)}）。
        {period === 'all'
          ? '总榜以注册时赠送的 ¥1,000,000 初始资金为基准。'
          : '系统每分钟记录一次资产快照与大盘指数作为周期基准，快照积累越多周期榜越准确。'}
      </Text>
    </Card>
  );
}
