import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// 由 auth context 注册：清理内存态并回到登录页，而不是硬跳转根路径
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  unauthorizedHandler = fn;
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('pt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response && err.response.status === 401) {
      localStorage.removeItem('pt_token');
      if (unauthorizedHandler) unauthorizedHandler();
      else window.location.href = window.location.origin + '/';
    }
    return Promise.reject(err);
  }
);

export default api;
