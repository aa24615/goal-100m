import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Space, Avatar, Dropdown, Typography, Tabs } from 'antd';
import {
  LineChartOutlined,
  StarOutlined,
  WalletOutlined,
  HistoryOutlined,
  TrophyOutlined,
  LogoutOutlined,
  UserOutlined,
  DownOutlined,
} from '@ant-design/icons';
import { useAuth } from './auth';
import Login from './pages/Login';
import Market from './pages/Market';
import Watchlist from './pages/Watchlist';
import StockDetail from './pages/StockDetail';
import Portfolio from './pages/Portfolio';
import Transactions from './pages/Transactions';
import Leaderboard from './pages/Leaderboard';
import { formatMoney } from './utils';
import { subscribe } from './ws';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const menuItems = [
  { key: '/market', icon: <LineChartOutlined />, label: '行情中心' },
  { key: '/watchlist', icon: <StarOutlined />, label: '自选股' },
  { key: '/portfolio', icon: <WalletOutlined />, label: '我的持仓' },
  { key: '/transactions', icon: <HistoryOutlined />, label: '交易记录' },
  { key: '/leaderboard', icon: <TrophyOutlined />, label: '收益排行榜' },
];

const MENU_LABEL: Record<string, string> = {
  '/market': '行情中心',
  '/watchlist': '自选股',
  '/portfolio': '我的持仓',
  '/transactions': '交易记录',
  '/leaderboard': '收益排行榜',
};

const HOME = '/market';
const STORAGE_KEY = 'qc_tabs';

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
    const raw = sessionStorage.getItem(STORAGE_KEY);
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

export default function App() {
  const { token, user, assets, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [tabs, setTabs] = useState<TabItem[]>(loadTabs);
  const [names, setNames] = useState<Record<string, string>>({});

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

  // 当前路由进入标签栏：已存在则激活，不存在则新增
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

  // 标签栏持久化到 sessionStorage，刷新页面后恢复
  useEffect(() => {
    if (!token) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
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

  const selectedKey =
    ['/market', '/watchlist', '/portfolio', '/transactions', '/leaderboard'].find((k) =>
      pathname.startsWith(k)
    ) || '/market';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme="light"
        width={200}
        style={{ background: '#fff', borderRight: '1px solid #eef4f3' }}
      >
        <div className="logo">
          <span className="logo-main">赚他一个小目标</span>
          <span className="logo-sub">模拟股票</span>
        </div>
        <Menu
          theme="light"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={(e) => navigate(e.key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}
        >
          <Text strong style={{ fontSize: 16 }}>
            A 股模拟交易大厅
          </Text>
          <Space size="large">
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
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: '退出登录',
                    onClick: logout,
                  },
                ],
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar icon={<UserOutlined />} style={{ background: '#0ea5a4' }} />
                <Text>{user?.username}</Text>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: 16, padding: 0 }}>
          <div
            style={{
              background: '#fff',
              borderRadius: 10,
              padding: '6px 12px 0',
              marginBottom: 12,
            }}
          >
            <Tabs
              hideAdd
              size="small"
              type="editable-card"
              activeKey={pathname}
              items={tabs.map((t) => ({ key: t.key, label: t.label, closable: t.closable }))}
              onChange={(k) => navigate(k)}
              onEdit={(e, action) => {
                if (action === 'remove') removeTab(String(e));
              }}
              tabBarExtraContent={{
                right: (
                  <Dropdown
                    menu={{
                      items: [
                        { key: 'others', label: '关闭其他' },
                        { key: 'all', label: '关闭全部' },
                      ],
                      onClick: ({ key }) => {
                        if (key === 'others') closeOthers();
                        else if (key === 'all') closeAll();
                      },
                    }}
                  >
                    <Button size="small" type="text">
                      标签操作 <DownOutlined />
                    </Button>
                  </Dropdown>
                ),
              }}
            />
          </div>

          <Routes>
            <Route path="/market" element={<Market />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/stock/:code" element={<StockDetail />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
