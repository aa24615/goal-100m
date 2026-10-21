import React from 'react';
import { Avatar } from 'antd';
import { getAvatar } from '../avatars';

interface Props {
  avatarKey?: string | null;
  name?: string;
  username?: string;
  size?: number | 'large' | 'small' | 'default';
  fontSize?: number;
  style?: React.CSSProperties;
}

// 统一的用户头像：有预设头像则显示 emoji，否则用昵称/用户名首字母兜底。
// 顶栏与资料页共用，避免两处各自实现首字母逻辑导致不一致。
export default function UserAvatar({ avatarKey, name, username, size = 'default', fontSize, style }: Props) {
  const preset = getAvatar(avatarKey);
  const initial = (name || username || '?').charAt(0).toUpperCase();
  return (
    <Avatar
      size={size}
      style={{ background: preset?.color || '#0ea5a4', fontSize, ...style }}
    >
      {preset ? preset.emoji : initial}
    </Avatar>
  );
}
