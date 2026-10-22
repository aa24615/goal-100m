import React, { useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  Layout,
  Menu,
  Space,
  Dropdown,
  Typography,
  Modal,
  Form,
  Input,
  Button,
  App as AntApp,
  ConfigProvider,
  theme,
  Grid,
  Drawer,
  Alert,
  message as AntdMessage,
} from 'antd';
import {
  LineChartOutlined,
  StarOutlined,
  WalletOutlined,
  HistoryOutlined,
  TrophyOutlined,
  LogoutOutlined,
  UserOutlined,
  ReloadOutlined,
  FieldTimeOutlined,
  MenuOutlined,
  BookOutlined,
  ExperimentOutlined,
  TeamOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import { useAuth } from './auth';
import api, { getResetNotice, resetAccount, getPreferences, savePreferences, updateGuide } from './api';
import Login from './pages/Login';
import Market from './pages/Market';
import Watchlist from './pages/Watchlist';
import StockDetail from './pages/StockDetail';
import Portfolio from './pages/Portfolio';
import Orders from './pages/Orders';
import Transactions from './pages/Transactions';
import Leaderboard from './pages/Leaderboard';
import Profile from './pages/Profile';
import Replay from './pages/Replay';
import Review from './pages/Review';
import Scenarios from './pages/Scenarios';
import Rooms from './pages/Rooms';
import { formatMoney } from './utils';
import { subscribe } from './ws';
import UserAvatar from './components/UserAvatar';
import TabBar from './components/TabBar';
import GuideOverlay from './components/GuideOverlay';
import MarketStatusBar, { ThemeControls } from './components/MarketStatusBar';
import { HOME, TABS_STORAGE_KEY, NAV_ORDER, MENU_LABEL } from './constants';
import type { MarketStatus, Preferences } from './types';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;
const { useBreakpoint } = Grid;

const NAV_ICONS: Record<string, React.ReactNode> = {
  '/market': <LineChartOutlined />,
  '/watchlist': <StarOutlined />,
  '/portfolio': <WalletOutlined />,
  '/orders': <FieldTimeOutlined />,
  '/transactions': <HistoryOutlined />,
  '/replay': <RedoOutlined />,
  '/review': <BookOutlined />,
  '/scenarios': <ExperimentOutlined />,
  '/rooms': <TeamOutlined />,
  '/leaderboard': <TrophyOutlined />,
  '/profile': <UserOutlined />,
};

const menuItems = NAV_ORDER.map((key) => ({ key, icon: NAV_ICONS[key], label: MENU_LABEL[key] }));

interface TabItem {
  key: string;
  label: string;
  closable: boolean;
}

function homeTab(): TabItem {
  return { key: HOME, label: MENU_LABEL[HOME], closable: false };
}

function loadTabs(): TabItem[] {
  try {
    const raw = sessionStorage.getItem(TABS_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const valid = arr.filter((t) => t && typeof t.key === 'string' && typeof t.label === 'string');
        if (valid.length > 0) {
          return valid.some((t) => t.key === HOME) ? valid : [homeTab(), ...valid];
        }
      }
    }
  } catch {
    /* 忽略解析错误，回落到默认标签 */
  }
  return [homeTab()];
}

function isTabPath(p: string) {
  return Boolean(MENU_LABEL[p]) || /^\/stock\/[^/]+$/.test(p);
}

function resolveLabel(path: string, names: Record<string, string>): string {
  if (MENU_LABEL[path]) return MENU_LABEL[path];
  const m = path.match(/^\/stock\/(.+)$/);
  if (m) {
    const code = decodeURIComponent(m[1]).toUpperCase();
    return names[code] ? `${names[code]} ${code}` : code;
  }
  return path;
}

function Shell() {
  const { token, user, assets, logout, refreshAssets } = useAuth();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = useBreakpoint();
  const isMobile = !screens.lg;

  const [tabs, setTabs] = useState<TabItem[]>(loadTabs);
  const [names, setNames] = useState<Record<string, string>>({});
  const [pwdOpen, setPwdOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [pwdForm] = Form.useForm();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // RQ-27 交易日状态
  const [status, setStatus] = useState<MarketStatus | null>(null);
  // RQ-33 深色模式与信息密度
  const [prefs, setPrefs] = useState<Preferences>({ theme: 'light', density: 'normal' });
  // RQ-34 重置约束
  const [resetNotice, setResetNotice] = useState<{
    cooldownHours: number;
    cooldownLeftHours: number;
    canReset: boolean;
    resetCount: number;
    impact: string[];
  } | null>(null);
  const [guideKey, setGuideKey] = useState(0);

  useEffect(() => {
    if (!token) return;
    getPreferences()
      .then((r) => setPrefs(r.data))
      .catch(() => setPrefs({ theme: 'light', density: 'normal' }));
  }, [token]);

  // 深色模式：切换 body 标记，避免布局之外的区域仍是浅色
  useEffect(() => {
    document.body.dataset.theme = prefs.theme;
    document.body.dataset.density = prefs.density;
  }, [prefs]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await api.get<MarketStatus>('/market/status');
      setStatus(r.data);
    } catch {
      /* 行情状态获取失败不影响主流程 */
    }
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    refreshStatus();
    const t = window.setInterval(refreshStatus, 10000);
    return () => window.clearInterval(t);
  }, [token, refreshStatus]);

  // 只维护 code -> name 映射；名称未变化则返回原引用，避免每 tick 触发重渲染
  useEffect(
    () =>
      subscribe((qs) => {
        setNames((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const q of qs) {
            if (next[q.code] !== q.name) {
              next[q.code] = q.name;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }),
    []
  );

  const pathname = location.pathname;

  useEffect(() => {
    if (!token || !isTabPath(pathname)) return;
    const label = resolveLabel(pathname, names);
    setTabs((prev) => {
      const exist = prev.find((t) => t.key === pathname);
      if (exist) {
        if (exist.label === label) return prev;
        return prev.map((t) => (t.key === pathname ? { ...t, label } : t));
      }
      return [...prev, { key: pathname, label, closable: pathname !== HOME }];
    });
  }, [pathname, names, token]);

  useEffect(() => {
    if (!token) return;
    sessionStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
  }, [tabs, token]);

  if (!token) {
    return <Login />;
  }

  if (!isTabPath(pathname)) {
    return <Navigate to={HOME} replace />;
  }

  const removeTab = (key: string) => {
    if (key === HOME) return;
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const rest = tabs.filter((t) => t.key !== key);
    const list = rest.length > 0 ? rest : [homeTab()];
    setTabs(list);
    if (key === pathname) {
      const target = list[idx] || list[idx - 1] || list[list.length - 1];
      if (target) navigate(target.key);
    }
  };

  const closeOthers = () => {
    setTabs(tabs.filter((t) => t.key === pathname || t.key === HOME));
  };

  const closeAll = () => {
    setTabs([homeTab()]);
    navigate(HOME);
  };

  const selectedKey = NAV_ORDER.find((k) => pathname.startsWith(k)) || '/market';

  const openReset = async () => {
    try {
      const r = await getResetNotice();
      setResetNotice(r.data);
    } catch {
      setResetNotice(null);
    }
    setResetOpen(true);
  };

  const doReset = async () => {
    setResetLoading(true);
    try {
      const r = await resetAccount('确认重置');
      message.success(`账户已重置，资金恢复 ${formatMoney(r.data.cash)}（第 ${r.data.resetCount} 次重置）`);
      setResetOpen(false);
      await refreshAssets();
    } catch (e: any) {
      message.error(e?.response?.data?.error || '重置失败');
    } finally {
      setResetLoading(false);
    }
  };

  const nav = (
    <Menu
      theme={prefs.theme === 'dark' ? 'dark' : 'light'}
      mode="inline"
      selectedKeys={[selectedKey]}
      items={menuItems}
      onClick={(e) => {
        navigate(e.key);
        setDrawerOpen(false);
      }}
      style={{ borderInlineEnd: 'none' }}
    />
  );

  return (
    <ConfigProvider
      theme={{
        algorithm: prefs.theme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#0d9488' },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        {!isMobile && (
          <Sider theme={prefs.theme === 'dark' ? 'dark' : 'light'} width={200} breakpoint="lg" collapsedWidth={0}>
            <div className="logo">
              <span className="logo-main">赚他一个小目标</span>
              <span className="logo-sub">模拟股票</span>
            </div>
            {nav}
          </Sider>
        )}

        <Layout>
          <Header
            style={{
              background: prefs.theme === 'dark' ? '#141414' : '#fff',
              padding: '0 16px',
              minHeight: 64,
              height: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              rowGap: 8,
            }}
          >
            <Space size="small" wrap>
              {isMobile && <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} />}
              {!isMobile && <Text strong style={{ fontSize: 16 }}>A 股模拟交易大厅</Text>}
              {status && <MarketStatusBar status={status} />}
            </Space>
            <Space size="large" wrap>
              <Space size="small">
                <Text type="secondary">总资产</Text>
                <Text strong className="money">
                  {formatMoney(assets?.totalAssets ?? 0)}
                </Text>
              </Space>
              <Space size="small">
                <Text type="secondary">可用</Text>
                <Text className="money">{formatMoney(assets?.cash ?? 0)}</Text>
              </Space>
              <ThemeControls
                theme={prefs.theme}
                density={prefs.density}
                onChange={(p) => {
                  setPrefs((cur) => ({ ...cur, ...p }));
                  savePreferences(p).catch(() => {
                    /* 偏好保存失败不影响本地使用 */
                  });
                }}
              />
              <Dropdown
                menu={{
                  items: [
                    { key: 'profile', icon: <UserOutlined />, label: '个人资料', onClick: () => navigate('/profile') },
                    { key: 'account', icon: <UserOutlined />, label: '修改密码', onClick: () => setPwdOpen(true) },
                    {
                      key: 'guide',
                      icon: <BookOutlined />,
                      label: '重看新手引导',
                      onClick: async () => {
                        await updateGuide('step', 1);
                        setGuideKey((k) => k + 1);
                        AntdMessage.info('引导已重新打开');
                      },
                    },
                    { key: 'reset', icon: <ReloadOutlined />, label: '重置模拟账户', onClick: openReset },
                    { type: 'divider' },
                    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout },
                  ],
                }}
              >
                <Space style={{ cursor: 'pointer' }}>
                  <UserAvatar avatarKey={user?.avatar} name={user?.displayName} username={user?.username} />
                  <Text>{user?.displayName || user?.username}</Text>
                </Space>
              </Dropdown>
            </Space>
          </Header>

          <TabBar
            activeKey={pathname}
            items={tabs}
            onChange={(k) => navigate(k)}
            onRemove={removeTab}
            onCloseOthers={closeOthers}
            onCloseAll={closeAll}
          />

          {/* RQ-25：移动端收窄内边距，避免横向滚动 */}
          <Content style={{ margin: isMobile ? 8 : 16, padding: 0 }}>
            <div className="page-card">
              <Routes>
                <Route path="/market" element={<Market />} />
                <Route path="/watchlist" element={<Watchlist />} />
                <Route path="/stock/:code" element={<StockDetail />} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/transactions" element={<Transactions />} />
                <Route path="/replay" element={<Replay />} />
                <Route path="/review" element={<Review />} />
                <Route path="/scenarios" element={<Scenarios />} />
                <Route path="/rooms" element={<Rooms />} />
                <Route path="/leaderboard" element={<Leaderboard />} />
                <Route path="/profile" element={<Profile />} />
              </Routes>
            </div>
          </Content>
        </Layout>

        {isMobile && (
          <Drawer
            placement="left"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            width={200}
            styles={{ body: { padding: 0 } }}
          >
            {nav}
          </Drawer>
        )}

        {/* RQ-12：引导浮层，注册后自动出现、可跳过、可重看 */}
        <GuideOverlay key={guideKey} />
      </Layout>

      <Modal title="修改密码" open={pwdOpen} onCancel={() => { setPwdOpen(false); pwdForm.resetFields(); }} footer={null}>
        <Form
          form={pwdForm}
          layout="vertical"
          onFinish={async (v) => {
            setPwdLoading(true);
            try {
              await api.post('/account/password', { oldPassword: v.oldPassword, newPassword: v.newPassword });
              message.success('密码修改成功');
              setPwdOpen(false);
              pwdForm.resetFields();
            } catch (e: any) {
              message.error(e?.response?.data?.error || '修改失败');
            } finally {
              setPwdLoading(false);
            }
          }}
        >
          <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
            <Input.Password placeholder="原密码" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, max: 32, message: '8-32 位' },
              { validator: (_, val) => (!val || /^\d+$/.test(val) ? Promise.reject(new Error('密码不能全为数字')) : Promise.resolve()) },
            ]}
          >
            <Input.Password placeholder="8-32 位，建议字母+数字" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入' },
              ({ getFieldValue }) => ({
                validator: (_, val) => (!val || val === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={pwdLoading}>
            确认修改
          </Button>
        </Form>
      </Modal>

      {/* RQ-34：重置需二次确认，并展示冷却与影响 */}
      <Modal
        title="重置模拟账户"
        open={resetOpen}
        onCancel={() => setResetOpen(false)}
        onOk={doReset}
        confirmLoading={resetLoading}
        okText="确认重置"
        cancelText="取消"
        okButtonProps={{ disabled: resetNotice ? !resetNotice.canReset : false, danger: true }}
      >
        {resetNotice && (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                resetNotice.canReset
                  ? `重置后需等待 ${resetNotice.cooldownHours} 小时才能再次重置`
                  : `账户重置冷却中，请 ${resetNotice.cooldownLeftHours} 小时后再试`
              }
            />
            <p>将清空你的全部持仓、交易记录与净值快照，资金恢复为初始金额。此操作不可恢复。</p>
            <ul>
              {resetNotice.impact.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            {resetNotice.resetCount > 0 && (
              <p style={{ color: '#8c8c8c', fontSize: 12 }}>
                你已重置过 {resetNotice.resetCount} 次，排行榜会标注起点变化。
              </p>
            )}
          </>
        )}
      </Modal>
    </ConfigProvider>
  );
}

export default function App() {
  return (
    <AntApp>
      <Shell />
    </AntApp>
  );
}
