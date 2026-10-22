import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Input, Row, Space, Statistic, Table, Tag, App, Modal, Form, Segmented } from 'antd';
import { createRoom, joinRoom, listRooms, getRoom, closeRoom } from '../api';
import type { Room, RoomDetail } from '../types';
import { formatMoney } from '../utils';
import Disclaimer from '../components/Disclaimer';

const DURATIONS = [
  { label: '1 个交易日', value: '1d' },
  { label: '3 个交易日', value: '3d' },
  { label: '1 周（5 日）', value: '1w' },
];

// 房间赛（RQ-20 ~ RQ-22）：随时开局、邀请码加入、房间内实时排名、结束生成战绩卡。
export default function Rooms() {
  const { message } = App.useApp();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const r = await listRooms();
      setRooms(r.data);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(async () => {
      load();
      if (detail) {
        try {
          const r = await getRoom(detail.id);
          setDetail(r.data);
        } catch {
          /* 房间可能已结束 */
        }
      }
    }, 4000); // 4 秒刷新，满足「排名延迟 ≤5 秒」
    return () => window.clearInterval(t);
  }, [load, detail?.id]);

  const onCreate = async (v: { name: string; duration: string }) => {
    try {
      const r = await createRoom(v.name, v.duration);
      message.success(`房间已创建，邀请码 ${r.data.code}`);
      setCreating(false);
      form.resetFields();
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.error || '创建失败');
    }
  };

  const onJoin = async (code: string) => {
    if (!code) return;
    try {
      const r = await joinRoom(code);
      message.success('已加入房间赛');
      load();
      const d = await getRoom(r.data.id);
      setDetail(d.data);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加入失败');
    }
  };

  if (detail) {
    return (
      <div>
        <Disclaimer text="房间赛为模拟竞技，收益统计基于加入时刻的资产快照，不构成投资建议" />
        <Card
          title={`${detail.name}（邀请码 ${detail.code}）`}
          extra={
            <Space>
              <Button onClick={() => setDetail(null)}>返回列表</Button>
              <Button
                type="primary"
                onClick={async () => {
                  const r = await closeRoom(detail.id);
                  setDetail(r.data);
                }}
              >
                结束并生成战绩卡
              </Button>
            </Space>
          }
        >
          <Alert type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }} message={detail.note} />
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={8}>
              <Statistic title="参与人数" value={detail.members.length} suffix="人" />
            </Col>
            <Col span={8}>
              <Statistic title="剩余交易日" value={detail.progress.remainSessions} />
            </Col>
            <Col span={8}>
              <Statistic title="状态" value={detail.status === 'CLOSED' ? '已结束' : '进行中'} />
            </Col>
          </Row>
          <Table
            size="small"
            rowKey="userId"
            pagination={false}
            dataSource={detail.members}
            columns={[
              { title: '排名', dataIndex: 'rank', width: 70 },
              { title: '成员', dataIndex: 'displayName' },
              { title: '起始快照', dataIndex: 'baseAssets', render: (v: number) => formatMoney(v) },
              { title: '当前资产', dataIndex: 'totalAssets', render: (v: number) => formatMoney(v) },
              {
                title: '区间收益率',
                dataIndex: 'returnPct',
                render: (v: number) => <span className={v >= 0 ? 'up' : 'down'}>{v}%</span>,
              },
            ]}
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Disclaimer text="房间赛为模拟竞技，所有参与者统计窗口一致，不构成投资建议" />
      <Card
        title="房间赛"
        extra={
          <Space>
            <Input.Search
              placeholder="输入邀请码加入"
              enterButton="加入"
              style={{ width: 220 }}
              onSearch={onJoin}
              data-testid="join-code"
            />
            <Button type="primary" onClick={() => setCreating(true)} data-testid="create-room">
              创建房间
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          dataSource={rooms}
          locale={{ emptyText: <Empty description="还没有房间赛，创建一个和朋友比一把" /> }}
          pagination={false}
          columns={[
            { title: '房间', dataIndex: 'name' },
            { title: '邀请码', dataIndex: 'code', render: (v: string) => <Tag color="blue">{v}</Tag> },
            { title: '人数', dataIndex: 'memberCount' },
            {
              title: '周期',
              render: (_: unknown, r: Room) => `${r.durationSessions} 个交易日`,
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (v: string) => <Tag color={v === 'CLOSED' ? 'default' : 'green'}>{v === 'CLOSED' ? '已结束' : '进行中'}</Tag>,
            },
            {
              title: '操作',
              render: (_: unknown, r: Room) => (
                <Button
                  size="small"
                  onClick={async () => {
                    const d = await getRoom(r.id);
                    setDetail(d.data);
                  }}
                >
                  查看详情
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Modal open={creating} title="创建房间赛" onCancel={() => setCreating(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={onCreate} initialValues={{ duration: '1d' }}>
          <Form.Item name="name" label="房间名称" rules={[{ required: true, message: '请输入房间名称' }]}>
            <Input placeholder="例如：周五下班练一把" maxLength={60} />
          </Form.Item>
          <Form.Item name="duration" label="赛程">
            <Segmented options={DURATIONS} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
