import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api, { setUnauthorizedHandler } from './api';
import { reconnect as reconnectWs } from './ws';
import type { User, Portfolio } from './types';

interface AuthContextValue {
  token: string | null;
  user: User | null;
  assets: { cash: number; totalAssets: number } | null;
  login: (account: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshAssets: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('pt_token'));
  const [user, setUser] = useState<User | null>(null);
  const [assets, setAssets] = useState<{ cash: number; totalAssets: number } | null>(null);

  const refreshAssets = useCallback(async () => {
    try {
      const r = await api.get<Portfolio>('/portfolio');
      setAssets({ cash: r.data.cash, totalAssets: r.data.totalAssets });
    } catch {
      /* ignore */
    }
  }, []);

  // 401 时由拦截器回调清理登录态，避免硬跳转导致内存态残留
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
      setAssets(null);
    });
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setAssets(null);
      return;
    }
    api
      .get<User>('/me')
      .then((r) => setUser(r.data))
      .catch(() => {
        localStorage.removeItem('pt_token');
        setToken(null);
      });
    refreshAssets();
  }, [token, refreshAssets]);

  const login = async (account: string, password: string) => {
    const r = await api.post<{ token: string; user: User }>('/auth/login', { account, password });
    localStorage.setItem('pt_token', r.data.token);
    setToken(r.data.token);
    setUser(r.data.user);
    reconnectWs(); // 用新 token 重建行情连接
  };

  const register = async (username: string, email: string, password: string) => {
    const r = await api.post<{ token: string; user: User }>('/auth/register', { username, email, password });
    localStorage.setItem('pt_token', r.data.token);
    setToken(r.data.token);
    setUser(r.data.user);
    reconnectWs();
  };

  const logout = () => {
    localStorage.removeItem('pt_token');
    setToken(null);
    setUser(null);
    setAssets(null);
    reconnectWs();
  };

  return (
    <AuthContext.Provider value={{ token, user, assets, login, register, logout, refreshAssets }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
