import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Disclaimer from './Disclaimer';
import { DISCLAIMER } from '../constants';

// RQ-29（P2/P4）：免责声明此前只在登录页出现，交易与持仓页缺失。
describe('Disclaimer (RQ-29)', () => {
  it('默认展示模拟交易免责声明', () => {
    render(<Disclaimer />);
    expect(screen.getByText(DISCLAIMER)).toBeInTheDocument();
  });

  it('声明文本包含「模拟交易」与「不构成投资建议」', () => {
    render(<Disclaimer />);
    const text = screen.getByText(DISCLAIMER).textContent || '';
    expect(text).toContain('模拟交易');
    expect(text).toContain('不构成投资建议');
  });

  it('支持自定义文案（剧本/房间赛场景用）', () => {
    render(<Disclaimer text="本场景为虚构行情，不构成任何投资建议" />);
    expect(screen.getByText('本场景为虚构行情，不构成任何投资建议')).toBeInTheDocument();
  });
});
