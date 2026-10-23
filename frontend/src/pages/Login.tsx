import React, { useState } from 'react';
import { Card, Tabs, Form, Input, Button, Typography, App, Divider } from 'antd';
import { useAuth } from '../auth';
import Forgot from './Forgot';

const { Title, Paragraph, Text } = Typography;

export default function Login() {
  const { login, register } = useAuth();
  const { message } = App.useApp();
  // 登录与注册各自独立的 loading 状态，避免互相干扰
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  // RQ-30：密码找回入口（此前忘记密码只能弃号重开）
  const [forgot, setForgot] = useState(false);

  if (forgot) return <Forgot />;

  const onLogin = async (values: any) => {
    setLoginLoading(true);
    try {
      await login(String(values.account || '').trim(), values.password);
      message.success('登录成功');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const onRegister = async (values: any) => {
    setRegisterLoading(true);
    try {
      await register(
        String(values.username || '').trim(),
        String(values.email || '').trim(),
        values.password
      );
      message.success('注册成功，已赠送 ¥1,000,000 模拟资金');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '注册失败');
    } finally {
      setRegisterLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
        background: 'linear-gradient(135deg, #f2fbfa 0%, #dcf1ee 100%)',
      }}
    >
      {/* 装饰光斑 */}
      <div
        style={{
          position: 'absolute',
          width: 360,
          height: 360,
          right: -90,
          top: -120,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(20,184,166,0.18) 0%, rgba(20,184,166,0) 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 300,
          height: 300,
          left: -80,
          bottom: -100,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(13,148,136,0.14) 0%, rgba(13,148,136,0) 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* 中部内容区：占满剩余高度并垂直居中 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div style={{ width: '100%', maxWidth: 880, display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
          <div className="brand-pitch" style={{ maxWidth: 380, padding: '20px 0' }}>
            <Title style={{ color: '#0f766e', marginBottom: 4 }}>赚一个小目标</Title>
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
                      <Button type="primary" htmlType="submit" block size="large" loading={loginLoading}>
                        登录
                      </Button>
                      {/* RQ-30：忘记密码不再是死路 */}
                      <div style={{ textAlign: 'right', marginTop: 8 }}>
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setForgot(true)} data-testid="goto-forgot">
                          忘记密码？
                        </Button>
                      </div>
                    </Form>
                  ),
                },
                {
                  key: 'register',
                  label: '注册',
                  children: (
                    <Form layout="vertical" onFinish={onRegister}>
                      <Form.Item
                        name="username"
                        label="用户名"
                        rules={[
                          { required: true, message: '请输入用户名' },
                          {
                            pattern: /^[a-zA-Z0-9_]{3,20}$/,
                            message: '3-20 位字母、数字或下划线',
                          },
                        ]}
                      >
                        <Input size="large" placeholder="3-20 位字母/数字/下划线" />
                      </Form.Item>
                      <Form.Item
                        name="email"
                        label="邮箱"
                        rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
                      >
                        <Input size="large" placeholder="用于账号识别" />
                      </Form.Item>
                      <Form.Item
                        name="password"
                        label="密码"
                        rules={[
                          { required: true, message: '请输入密码' },
                          { min: 8, max: 32, message: '密码需 8-32 位' },
                          {
                            validator: (_, v) =>
                              !v || /^\d+$/.test(v)
                                ? Promise.reject(new Error('密码不能全为数字'))
                                : Promise.resolve(),
                          },
                        ]}
                      >
                        <Input.Password size="large" placeholder="8-32 位，建议字母+数字" />
                      </Form.Item>
                      <Form.Item
                        name="confirm"
                        label="确认密码"
                        dependencies={['password']}
                        rules={[
                          { required: true, message: '请再次输入密码' },
                          ({ getFieldValue }) => ({
                            validator: (_, v) =>
                              !v || v === getFieldValue('password')
                                ? Promise.resolve()
                                : Promise.reject(new Error('两次输入的密码不一致')),
                          }),
                        ]}
                      >
                        <Input.Password size="large" placeholder="再次输入密码" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" block size="large" loading={registerLoading}>
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

      <footer className="auth-footer">
        <div>
          <span style={{ color: '#0d9488', fontWeight: 600 }}>赚一个小目标 · 模拟股票</span>
          <span>　|　仅供模拟练习，不构成任何投资建议</span>
        </div>
        <div>
          <a href="#" onClick={(e) => e.preventDefault()}>模拟交易说明</a>
          <a href="#" onClick={(e) => e.preventDefault()}>风险揭示</a>
          <a href="#" onClick={(e) => e.preventDefault()}>联系我们</a>
        </div>
        <div style={{ opacity: 0.8 }}>© {new Date().getFullYear()} 模拟股票实验室 · 虚拟资金 ¥1,000,000 起</div>
      </footer>
    </div>
  );
}
