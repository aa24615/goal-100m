import React, { useState } from 'react';
import { Card, Tabs, Form, Input, Button, Typography, App, Divider } from 'antd';
import { useAuth } from '../auth';

const { Title, Paragraph, Text } = Typography;

export default function Login() {
  const { login, register } = useAuth();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onLogin = async (values: any) => {
    setLoading(true);
    try {
      await login(values.account, values.password);
      message.success('登录成功');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const onRegister = async (values: any) => {
    setLoading(true);
    try {
      await register(values.username, values.email, values.password);
      message.success('注册成功，已赠送 ¥1,000,000 模拟资金');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #f2fbfa 0%, #dcf1ee 100%)',
        padding: 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: 880, display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ maxWidth: 380, padding: '40px 0' }}>
          <Title style={{ color: '#0f766e', marginBottom: 4 }}>赚他一个小目标</Title>
          <div style={{ color: '#5f807d', fontSize: 14, letterSpacing: 3, marginBottom: 12 }}>
            模 拟 股 票
          </div>
          <Paragraph style={{ color: '#476b68', fontSize: 15 }}>
            零风险练盘感，百万模拟金起步。真实的 A 股风格行情、买卖撮合、持仓盈亏与收益排行榜，
            让你在虚拟环境中打磨交易纪律与策略。
          </Paragraph>
          <Divider style={{ borderColor: 'rgba(13,148,136,0.25)' }} />
          <Paragraph style={{ color: '#5f807d', fontSize: 13 }}>
            · 注册即赠 ¥1,000,000 虚拟资金<br />
            · 实时模拟行情（±10% 涨跌停）<br />
            · 多用户同台竞技，收益排行榜见真章<br />
            · 佣金 / 印花税 / 过户费全仿真
          </Paragraph>
        </div>
        <Card style={{ width: 360, boxShadow: '0 12px 40px rgba(13,148,136,0.16)', borderRadius: 12 }}>
          <Title level={4} style={{ textAlign: 'center', marginBottom: 24 }}>
            进入交易大厅
          </Title>
          <Tabs
            centered
            items={[
              {
                key: 'login',
                label: '登录',
                children: (
                  <Form layout="vertical" onFinish={onLogin}>
                    <Form.Item name="account" label="用户名 / 邮箱" rules={[{ required: true, message: '请输入账号' }]}>
                      <Input size="large" placeholder="用户名或邮箱" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
                      <Input.Password size="large" placeholder="密码" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                      登录
                    </Button>
                  </Form>
                ),
              },
              {
                key: 'register',
                label: '注册',
                children: (
                  <Form layout="vertical" onFinish={onRegister}>
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                      <Input size="large" placeholder="设置用户名" />
                    </Form.Item>
                    <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
                      <Input size="large" placeholder="用于找回账号" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}>
                      <Input.Password size="large" placeholder="至少 6 位" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                      注册并领取模拟金
                    </Button>
                  </Form>
                ),
              },
            ]}
          />
          <Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 12 }}>
            本平台为模拟交易，所有资金与行情均为虚拟，不涉及任何真实交易。
          </Text>
        </Card>
      </div>
    </div>
  );
}
