import React, { useEffect, useState } from 'react';
import { Card, Input, Button, Avatar, Typography, App, Divider, Space, Tag } from 'antd';
import { useAuth } from '../auth';
import { updateProfile } from '../api';
import { AVATARS, getAvatar } from '../avatars';
import { formatMoney } from '../utils';
import UserAvatar from '../components/UserAvatar';

const { Title, Text, Paragraph } = Typography;

export default function Profile() {
  const { user, refreshUser } = useAuth();
  const { message } = App.useApp();
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [avatar, setAvatar] = useState<string | null>(user?.avatar || null);
  const [saving, setSaving] = useState(false);

  // 用户切换或资料被外部更新时同步本地状态
  useEffect(() => {
    setDisplayName(user?.displayName || '');
    setAvatar(user?.avatar || null);
  }, [user?.displayName, user?.avatar]);

  const current = getAvatar(avatar);

  const onSave = async () => {
    setSaving(true);
    try {
      await updateProfile({
        displayName: displayName.trim() || user?.username || '',
        avatar: avatar,
      });
      await refreshUser();
      message.success('资料已保存');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Title level={4} style={{ marginBottom: 16 }}>
        个人资料
      </Title>

      <Card style={{ marginBottom: 16 }}>
        <Space align="center" size="large">
          <UserAvatar avatarKey={avatar} name={user?.displayName} username={user?.username} size={72} fontSize={36} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{user?.displayName || user?.username}</div>
            <Text type="secondary">@{user?.username}</Text>
          </div>
        </Space>
      </Card>

      <Card title="头像" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
            gap: 12,
          }}
        >
          {AVATARS.map((a) => {
            const active = (avatar || 'none') === a.key;
            return (
              <div
                key={a.key}
                onClick={() => setAvatar(a.key === 'none' ? null : a.key)}
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  padding: 8,
                  borderRadius: 10,
                  border: active ? '2px solid #0d9488' : '2px solid transparent',
                  background: active ? 'rgba(13,148,136,0.08)' : 'transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                <Avatar size={44} style={{ background: a.color, fontSize: 22 }}>
                  {a.emoji}
                </Avatar>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {a.key === 'none' ? '默认' : a.key}
                </Text>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="基本信息">
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">昵称</Text>
          <Input
            size="large"
            value={displayName}
            maxLength={40}
            showCount
            placeholder="给自己起个响亮的名字"
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ marginTop: 6 }}
          />
        </div>

        <Divider style={{ margin: '8px 0 16px' }} />

        <Paragraph style={{ marginBottom: 4 }}>
          <Text type="secondary">用户名</Text>
          <br />
          <Text strong>{user?.username}</Text>
        </Paragraph>
        <Paragraph style={{ marginBottom: 4 }}>
          <Text type="secondary">邮箱</Text>
          <br />
          <Text strong>{user?.email}</Text>
        </Paragraph>
        <Paragraph style={{ marginBottom: 4 }}>
          <Text type="secondary">初始模拟资金</Text>
          <br />
          <Text strong className="money">
            {formatMoney(user?.initialCapital || 0)}
          </Text>
        </Paragraph>
        <Paragraph style={{ marginBottom: 4 }}>
          <Text type="secondary">注册时间</Text>
          <br />
          <Text strong>
            {user?.createdAt ? new Date(user.createdAt).toLocaleString('zh-CN') : '-'}
          </Text>
        </Paragraph>

        <div style={{ marginTop: 20, textAlign: 'right' }}>
          <Tag color="cyan">模拟交易 · 资料仅用于展示</Tag>
          <Button type="primary" size="large" loading={saving} onClick={onSave}>
            保存修改
          </Button>
        </div>
      </Card>
    </div>
  );
}
