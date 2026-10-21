import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatCard from './StatCard';

// P2：纯展示组件，无网络依赖，验证渲染与透传。
describe('StatCard (P2)', () => {
  it('渲染标题与数值', () => {
    const { container } = render(<StatCard title="总资产" value={1000} precision={2} />);
    expect(screen.getByText('总资产')).toBeInTheDocument();
    // antd 会将数值拆分为整数/小数两个 span，用 textContent 整体校验
    expect(container.querySelector('.ant-statistic-content')?.textContent).toContain('1,000.00');
  });

  it('字符串数值（如已格式化的大盘指数）按原样展示', () => {
    const { container } = render(<StatCard title="模拟大盘" value="3,245.67" />);
    expect(screen.getByText('模拟大盘')).toBeInTheDocument();
    expect(container.querySelector('.ant-statistic-content')?.textContent).toContain('3,245.67');
  });

  it('suffix 节点随数值一起渲染', () => {
    const { container } = render(
      <StatCard title="涨跌幅" value={5} suffix={<span className="up">+5.00%</span>} />
    );
    expect(container.querySelector('.ant-statistic-content')?.textContent).toContain('+5.00%');
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
