import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserAvatar from './UserAvatar';

// P2：头像组件，验证“预设头像优先 / 首字母兜底”的两条分支。
describe('UserAvatar (P2)', () => {
  it('有头像 key 时显示对应 emoji', () => {
    render(<UserAvatar avatarKey="panda" username="alice" />);
    expect(screen.getByText('🐼')).toBeInTheDocument();
  });

  it('无头像时用用户名首字母大写兜底', () => {
    render(<UserAvatar avatarKey={null} username="bob" />);
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('既无头像也无用户名时回退到 ?', () => {
    render(<UserAvatar />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('昵称优先于用户名字母展示', () => {
    render(<UserAvatar avatarKey={null} name="火星" username="mars" />);
    expect(screen.getByText('火')).toBeInTheDocument();
  });
});
