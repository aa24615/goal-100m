/**
 * RQ-84 手机端适配 / RQ-89 列表分页与排序 / RQ-90 密码找回 —— 前端测试
 *
 * 优先级覆盖：P1 差异化 · P2 体验补齐 · P3 边界与异常 · P5 兼容性
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { useIsMobile, MOBILE_BREAKPOINT } from '../hooks/useIsMobile';
import Forgot from './Forgot';
import Market from './Market';
import type { StockQuote } from '../types';

/* -------------------- 手机视口模拟 -------------------- */

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => {
    const m = /max-width:\s*(\d+)px/.exec(query);
    const bp = m ? Number(m[1]) : MOBILE_BREAKPOINT;
    return {
      // 视口宽度小于断点即视为手机
      matches: mobile ? 768 <= bp : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

function HookProbe() {
  const isMobile = useIsMobile();
  return <div data-testid="is-mobile">{String(isMobile)}</div>;
}

/* ===================== P1 · RQ-84 手机端 ===================== */

describe('RQ-84 手机端适配（P1）', () => {
  afterEach(() => {
    setViewport(false);
  });

  it('P1 · 手机视口下 useIsMobile 返回 true', () => {
    setViewport(true);
    render(<HookProbe />);
    expect(screen.getByTestId('is-mobile').textContent).toBe('true');
  });

  it('P1 · 桌面视口下 useIsMobile 返回 false', () => {
    setViewport(false);
    render(<HookProbe />);
    expect(screen.getByTestId('is-mobile').textContent).toBe('false');
  });

  it('P3 · matchMedia 不可用时降级为桌面态，不抛错', () => {
    // 刻意移除 matchMedia 以验证降级路径
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(() => render(<HookProbe />)).not.toThrow();
    expect(screen.getByTestId('is-mobile').textContent).toBe('false');
    setViewport(false);
  });

  it('P5 · 断点常量与 CSS 媒体查询一致（768px）', () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
  });
});

/* ===================== P2 · RQ-89 列表分页与排序 ===================== */

vi.mock('../hooks/useMarket', () => ({
  useMarket: () => ({
    quotes: QUOTES,
    sectors: ['全部', '银行'],
    summary: { indexValue: 3000, indexPct: 0.5, up: 2, down: 1, flat: 0 },
  }),
}));

vi.mock('../hooks/useWatchlist', () => ({
  useWatchlist: () => ({ watch: [] as string[], toggle: vi.fn() }),
}));

/**
 * vi.mock 工厂会在模块导入阶段执行，而 mock 变量若用 const 声明会落入 TDZ。
 * 统一用 vi.hoisted 提前创建，避免「Cannot access before initialization」。
 */
const { mockForgot, QUOTES } = vi.hoisted(() => ({
  mockForgot: vi.fn(),
  QUOTES: Array.from({ length: 60 }, (_, i) => ({
    code: `6000${String(i).padStart(2, '0')}`,
    name: `标的${i}`,
    sector: '银行',
    price: 10 + i,
    change: i - 30,
    changePct: (i - 30) / 10,
    high: 11 + i,
    low: 9 + i,
    open: 10 + i,
    prevClose: 10 + i,
    volume: 1000 * (i + 1),
    amount: 10000 * (i + 1),
    updatedAt: '2026-10-26',
  })) as StockQuote[],
}));

// 单一 api mock：对同一路径重复调用 vi.mock 会互相覆盖，必须合并成一个工厂；
// 且 Market 会间接依赖 api 的其它导出（如 getOnboarding），因此基于原模块做部分 mock。
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: { get: vi.fn(() => Promise.resolve({ data: {} })) },
    forgotPassword: (...a: unknown[]) => mockForgot(...a),
    resetPassword: vi.fn(() => Promise.resolve({ data: { ok: true } })),
  };
});


describe('RQ-89 标的列表分页（P2）', () => {
  const renderMarket = () =>
    render(
      <ConfigProvider>
        <AntApp>
          <MemoryRouter>
            <Market />
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>
    );

  it('P2 · 每页从 15 条提升到 50 条', async () => {
    renderMarket();
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toBeDefined());
    const rows = document.querySelectorAll('tbody tr.ant-table-row');
    expect(rows.length).toBe(50);
  });

  it('P2 · 分页器显示总数与每页条数', async () => {
    renderMarket();
    await waitFor(() => expect(document.body.textContent).toContain('共 60 只标的'));
  });

  it('P2 · 涨跌幅列可排序（默认降序）', async () => {
    renderMarket();
    await waitFor(() => expect(document.querySelectorAll('tbody tr.ant-table-row').length).toBe(50));
    const first = document.querySelector('tbody tr.ant-table-row td:nth-child(4)')?.textContent || '';
    expect(first).toContain('%');
    // 降序排列时首个应是最大涨跌幅（+2.90%）
    expect(first).toContain('2.90');
  });
});

/* ===================== P1 · RQ-90 密码找回 ===================== */

describe('RQ-90 密码找回不宣称已发送（P1）', () => {
  beforeEach(() => mockForgot.mockReset());

  const renderForgot = () =>
    render(
      <ConfigProvider>
        <AntApp>
          <MemoryRouter>
            <Forgot />
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>
    );

  it('P1 · 邮件通道不可用时页面绝不出现「已发送」', async () => {
    mockForgot.mockResolvedValue({
      data: {
        message: '当前未配置可用的邮件发送通道，重置邮件无法发送。',
        delivered: false,
        channel: 'none',
        reason: 'SMTP 未配置',
        alternatives: ['配置 SMTP_HOST 后重启', '用原密码登录后修改'],
        ttlMinutes: 30,
        notice: '我们不会在邮件发不出去时假装发送成功',
      },
    });
    renderForgot();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByText('发送重置链接'));

    await waitFor(() => expect(screen.getByTestId('forgot-notice')).toBeTruthy());
    const notice = screen.getByTestId('forgot-notice');
    expect(notice.textContent).not.toContain('已发送');
    expect(notice.textContent).toContain('重置邮件无法发送');
  });

  it('P1 · 邮件不可用时展示替代路径与时限', async () => {
    mockForgot.mockResolvedValue({
      data: { message: '无法发送', delivered: false, alternatives: ['配置 SMTP_HOST 后重启'], ttlMinutes: 30, notice: 'n' },
    });
    renderForgot();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByText('发送重置链接'));

    await waitFor(() => expect(screen.getByTestId('forgot-notice')).toBeTruthy());
    expect(screen.getByTestId('forgot-notice').textContent).toContain('配置 SMTP_HOST 后重启');
    expect(screen.getByTestId('forgot-notice').textContent).toContain('30 分钟');
  });

  it('P1 · 邮件已发送时展示成功提示', async () => {
    mockForgot.mockResolvedValue({ data: { message: '若该邮箱已注册，重置链接已发送，请注意查收', delivered: true } });
    renderForgot();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByText('发送重置链接'));

    await waitFor(() => expect(screen.getByTestId('forgot-notice')).toBeTruthy());
    expect(screen.getByTestId('forgot-notice').textContent).toContain('已发送');
  });

  it('P3 · 邮箱格式非法时不提交，不产生任何提示（边界）', async () => {
    mockForgot.mockResolvedValue({ data: { message: '若该邮箱已注册，重置链接已发送，请注意查收', delivered: true } });
    renderForgot();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'not-an-email' } });
    await act(async () => {
      fireEvent.click(screen.getByText('发送重置链接'));
    });
    expect(mockForgot).not.toHaveBeenCalled();
    expect(screen.queryByTestId('forgot-notice')).toBeNull();
  });

  it('P3 · 未填写邮箱直接提交被拦截（边界）', async () => {
    mockForgot.mockResolvedValue({ data: { message: '已发送', delivered: true } });
    renderForgot();
    await act(async () => {
      fireEvent.click(screen.getByText('发送重置链接'));
    });
    expect(mockForgot).not.toHaveBeenCalled();
    expect(screen.queryByTestId('forgot-notice')).toBeNull();
  });

  it('P3 · 缺 delivered 字段的老响应不误报为失败（向后兼容）', async () => {
    mockForgot.mockResolvedValue({ data: { message: '若该邮箱已注册，重置链接已发送，请注意查收' } });
    renderForgot();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByText('发送重置链接'));
    await waitFor(() => expect(screen.getByTestId('forgot-notice')).toBeTruthy());
    expect(screen.getByTestId('forgot-notice').textContent).toContain('已发送');
  });
});
