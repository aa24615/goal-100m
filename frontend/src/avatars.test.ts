import { describe, it, expect } from 'vitest';
import { AVATARS, getAvatar } from './avatars';
import { AVATAR_KEYS } from './constants';

// P1：头像白名单与查询，需与后端 AVATAR_KEYS 保持一致。
describe('avatars (P1)', () => {
  it('AVATARS 含 none 默认项，且 key 集合与后端白名单一致', () => {
    const keys = AVATARS.map((a) => a.key);
    expect(keys).toContain('none');
    expect(keys).toEqual(expect.arrayContaining([...AVATAR_KEYS]));
    // 每个预设都应有 emoji 与 color
    for (const a of AVATARS) {
      expect(typeof a.emoji).toBe('string');
      expect(a.color).toMatch(/^#/);
    }
  });

  it('getAvatar 命中返回预设，未命中或空值返回 null', () => {
    expect(getAvatar('panda')?.emoji).toBe('🐼');
    expect(getAvatar('tiger')?.color).toBe('#ef4444');
    expect(getAvatar('not-exist')).toBeNull();
    expect(getAvatar(null)).toBeNull();
    expect(getAvatar(undefined)).toBeNull();
  });
});
