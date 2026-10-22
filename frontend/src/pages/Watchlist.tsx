import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Select, Button, Empty, Tag, Space, Input, Modal, Form, App } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { subscribe } from '../ws';
import { getWatchlist, addWatch, updateWatch, removeWatch } from '../api';
import type { StockQuote, WatchItem } from '../types';
import { formatNum, formatPct, changeClass } from '../utils';

// RQ-28：自选股从「收藏夹」升级为「观察笔记」—— 支持分组与关注理由备注，跨端一致。
export default function Watchlist() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [quotes, setQuotes] = useState<StockQuote[]>([]);
  const [items, setItems] = useState<WatchItem[]>([]);
  const [group, setGroup] = useState<string>('全部');
  const [editing, setEditing] = useState<WatchItem | null>(null);
  const [form] = Form.useForm();

  const reload = () => getWatchlist().then((r) => setItems(r.data)).catch(() => setItems([]));

  useEffect(() => subscribe(setQuotes), []);
  useEffect(() => {
    reload();
  }, []);

  const map = useMemo(() => {
    const m: Record<string, WatchItem> = {};
    for (const i of items) m[i.code] = i;
    return m;
  }, [items]);

  const groups = useMemo(() => ['全部', ...Array.from(new Set(items.map((i) => i.group)))], [items]);

  const watched = useMemo(() => {
    const codes = items.filter((i) => group === '全部' || i.group === group).map((i) => i.code);
    return quotes.filter((q) => codes.includes(q.code));
  }, [quotes, items, group]);

  const allOptions = useMemo(
    () => quotes.map((q) => ({ label: `${q.code} ${q.name}`, value: q.code })),
    [quotes]
  );

  const onAdd = async (code: string) => {
    try {
      await addWatch(code, group === '全部' ? '默认' : group);
      await reload();
      message.success('已加入自选');
    } catch {
      message.error('添加失败');
    }
  };

  const onRemove = async (code: string) => {
    await removeWatch(code).catch(() => undefined);
    reload();
  };

  const onSave = async (v: { group: string; note: string }) => {
    if (!editing) return;
    try {
      await updateWatch(editing.code, { group: v.group, note: v.note });
      message.success('已保存分组与备注');
      setEditing(null);
      reload();
    } catch {
      message.error('保存失败');
    }
  };

  const columns = [
    { title: '代码', dataIndex: 'code', render: (v: string) => <span className="money">{v}</span> },
    {
      title: '名称',
      dataIndex: 'name',
      render: (v: string, r: StockQuote) => <a onClick={() => navigate(`/stock/${r.code}`)}>{v}</a>,
    },
    {
      title: '分组',
      key: 'group',
      render: (_: unknown, r: StockQuote) => <Tag color="teal">{map[r.code]?.group || '默认'}</Tag>,
    },
    {
      title: '关注理由',
      key: 'note',
      render: (_: unknown, r: StockQuote) => (
        <span style={{ color: '#8c8c8c', fontSize: 12 }}>{map[r.code]?.note || '—'}</span>
      ),
    },
    {
      title: '最新价',
      dataIndex: 'price',
      align: 'right' as const,
      render: (v: number, r: StockQuote) => <span className={`money ${changeClass(r.change)}`}>{formatNum(v)}</span>,
    },
    {
      title: '涨跌幅',
      dataIndex: 'changePct',
      align: 'right' as const,
      render: (v: number, r: StockQuote) => <span className={`money ${changeClass(r.change)}`}>{formatPct(v)}</span>,
    },
    {
      title: '操作',
      render: (_: unknown, r: StockQuote) => (
        <Space size={4}>
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(map[r.code] || { code: r.code, stockCode: r.code, group: '默认', note: '', createdAt: '' });
              form.setFieldsValue({ group: map[r.code]?.group || '默认', note: map[r.code]?.note || '' });
            }}
          >
            备注
          </Button>
          <Button type="text" icon={<DeleteOutlined />} onClick={() => onRemove(r.code)} style={{ color: '#8c8c8c' }}>
            移除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="我的自选"
      extra={
        <Space wrap>
          <Select
            value={group}
            onChange={setGroup}
            style={{ width: 130 }}
            options={groups.map((g) => ({ label: g, value: g }))}
          />
          <Select
            showSearch
            placeholder="添加自选股"
            style={{ width: 200 }}
            value={null}
            options={allOptions}
            onChange={onAdd}
            filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          />
        </Space>
      }
    >
      {watched.length === 0 ? (
        <Empty description="还没有自选股，去行情中心点击☆添加吧" />
      ) : (
        <Table rowKey="code" size="middle" columns={columns} dataSource={watched} pagination={false} scroll={{ x: true }} />
      )}

      <Modal open={!!editing} title="分组与关注理由" onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={onSave}>
          <Form.Item name="group" label="分组">
            <Input maxLength={30} placeholder="例如：待观察 / 已建仓 / 练手标的" />
          </Form.Item>
          <Form.Item name="note" label="关注理由">
            <Input.TextArea rows={3} maxLength={500} placeholder="记录你为什么关注它，复盘时最有用" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
