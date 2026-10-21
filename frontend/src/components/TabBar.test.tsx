import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TabBar, { type TabItem } from './TabBar';

const items: TabItem[] = [
  { key: '/market', label: '行情中心', closable: false },
  { key: '/portfolio', label: '我的持仓', closable: true },
];

const noop = () => {};

// P2：标签栏交互，验证渲染、切换与关闭回调透传。
describe('TabBar (P2)', () => {
  it('渲染所有标签', () => {
    render(
      <TabBar activeKey="/market" items={items} onChange={noop} onRemove={noop} onCloseOthers={noop} onCloseAll={noop} />
    );
    expect(screen.getByText('行情中心')).toBeInTheDocument();
    expect(screen.getByText('我的持仓')).toBeInTheDocument();
  });

  it('点击标签触发 onChange 并透传 key', () => {
    const onChange = vi.fn();
    render(
      <TabBar activeKey="/market" items={items} onChange={onChange} onRemove={noop} onCloseOthers={noop} onCloseAll={noop} />
    );
    fireEvent.click(screen.getByText('我的持仓'));
    expect(onChange).toHaveBeenCalledWith('/portfolio');
  });

  it('可关闭标签的关闭按钮触发 onRemove', () => {
    const onRemove = vi.fn();
    const { container } = render(
      <TabBar activeKey="/market" items={items} onChange={noop} onRemove={onRemove} onCloseOthers={noop} onCloseAll={noop} />
    );
    const removeBtn = container.querySelector('.ant-tabs-tab-remove');
    expect(removeBtn).not.toBeNull();
    if (removeBtn) {
      fireEvent.click(removeBtn);
      expect(onRemove).toHaveBeenCalledWith('/portfolio');
    }
  });
});
