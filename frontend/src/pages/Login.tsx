import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Tabs, Form, Input, Button, Typography, App } from 'antd';
import { useAuth } from '../auth';
import Forgot from './Forgot';
import RetentionNoticeCard from '../components/RetentionNoticeCard';
import AuthShell from '../components/AuthShell';
import LoginBrand from '../components/LoginBrand';
import { getRetentionNotice, createGuestSession } from '../api';
import type { RetentionPayload } from '../types';

const { Title, Text } = Typography;

export default function Login() {
  const { login, register } = useAuth();
  const { message } = App.useApp();
  // 登录与注册各自独立的 loading 状态，避免互相干扰
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  // RQ-30：密码找回入口（此前忘记密码只能弃号重开）
  const [forgot, setForgot] = useState(false);
  // RQ-154 保留期承诺：注册页必须可见，文案一律取自后端，前端不复制常量
  const [retention, setRetention] = useState<RetentionPayload | null>(null);
  // 首屏「登录 / 注册保留成绩」CTA 需要真正切到注册 Tab；旧版传的是 setForgot(false)，点了没反应
  const [activeTab, setActiveTab] = useState('login');
  const navigate = useNavigate();

  /**
   * RQ-174「首访 → 训练 ≤2 次点击」中的游客入口。
   *
   * 只有一次点击：点「先练一局」→ 建游客会话 → 直接进训练页。
   * 刻意**不先弹注册框**——注册要求邮箱 + 两次密码，发生在用户还没看到
   * 任何价值之前，是整个漏斗里最贵的一次交互。
   */
  const [guestLoading, setGuestLoading] = useState(false);
  const onGuestTrain = async () => {
    setGuestLoading(true);
    try {
      const r = await createGuestSession();
      const token = r.data?.guestToken;
      if (token) {
        try {
          localStorage.setItem('pt_guest_token', token);
        } catch {
          /* 隐私模式下写不进，但本次会话仍可用内存中的 token 走完一局 */
        }
      }
      navigate('/blind');
    } catch {
      // 游客会话失败时不静默：明确告知，否则用户以为按钮坏了
      message.error('游客会话创建失败，可直接注册或稍后重试');
    } finally {
      setGuestLoading(false);
    }
  };

  useEffect(() => {
    getRetentionNotice()
      .then((r) => setRetention(r.data || null))
      .catch(() => setRetention(null));
  }, []);

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

  /**
   * RQ-128 渠道归因：从分享链接 ?ref= 取渠道并**持久化**。
   *
   * 持久化的理由：用户几乎不会「点开分享链接就立刻注册」——
   * 多半是先看两眼、关掉、过一天再回来。只看当次 URL 会把这部分人全部记成 direct，
   * 于是「哪个渠道的人会练」永远没有答案。
   */
  const resolveChannel = (): string | null => {
    try {
      const q = new URLSearchParams(window.location.search).get('ref');
      const key = 'pt_ref';
      if (q) {
        localStorage.setItem(key, q);
        return q;
      }
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const onRegister = async (values: any) => {
    setRegisterLoading(true);
    try {
      await register(
        String(values.username || '').trim(),
        String(values.email || '').trim(),
        values.password,
        resolveChannel()
      );
      message.success('注册成功，已赠送 ¥1,000,000 模拟资金');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '注册失败');
    } finally {
      setRegisterLoading(false);
    }
  };

  return (
    <AuthShell
      brand={
        <LoginBrand
          onGuestTrain={onGuestTrain}
          onRegister={() => setActiveTab('register')}
        />
      }
    >
      <Card className="auth-card">
        <Title level={4} style={{ textAlign: 'center', marginBottom: 24 }}>
          进入交易大厅
        </Title>
        <Tabs
          centered
          activeKey={activeTab}
          onChange={setActiveTab}
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
                  {/* RQ-154 保留期承诺：写在用户投入之前（注册页必须可见） */}
                  <div style={{ marginBottom: 12 }}>
                    <RetentionNoticeCard data={retention} />
                  </div>
                  <Button type="primary" htmlType="submit" block size="large" loading={registerLoading}>
                    注册并领取模拟金
                  </Button>
                </Form>
              ),
            },
          ]}
        />
        <Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 12 }}>
          真实 A 股行情 · 模拟资金与模拟交易 · 不涉及任何真实交易，不构成投资建议。
        </Text>
      </Card>
    </AuthShell>
  );
}
