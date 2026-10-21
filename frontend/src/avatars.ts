// 头像预设：与后端 AVATAR_KEYS 白名单保持一致
export interface AvatarPreset {
  key: string;
  emoji: string;
  color: string;
}

export const AVATARS: AvatarPreset[] = [
  { key: 'none', emoji: '🙂', color: '#94a3b8' },
  { key: 'panda', emoji: '🐼', color: '#0ea5a4' },
  { key: 'fox', emoji: '🦊', color: '#f59e0b' },
  { key: 'tiger', emoji: '🐯', color: '#ef4444' },
  { key: 'cat', emoji: '🐱', color: '#8b5cf6' },
  { key: 'dog', emoji: '🐶', color: '#3b82f6' },
  { key: 'rabbit', emoji: '🐰', color: '#ec4899' },
  { key: 'owl', emoji: '🦉', color: '#14b8a6' },
  { key: 'monkey', emoji: '🐵', color: '#f97316' },
  { key: 'lion', emoji: '🦁', color: '#eab308' },
  { key: 'frog', emoji: '🐸', color: '#22c55e' },
  { key: 'penguin', emoji: '🐧', color: '#0ea5e9' },
  { key: 'crab', emoji: '🦀', color: '#f43f5e' },
];

export function getAvatar(key?: string | null): AvatarPreset | null {
  if (!key) return null;
  return AVATARS.find((a) => a.key === key) ?? null;
}
