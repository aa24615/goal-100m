/**
 * 用本机 Chrome（headless + CDP）真实渲染项目页面并截图，供 README 使用。
 *
 * 用法：
 *   1) 先启动 Chrome 远程调试：
 *      "/c/Program Files/Google/Chrome/Application/chrome.exe" \
 *        --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/shot-profile \
 *        --no-first-run --no-default-browser-check --disable-gpu --hide-scrollbars about:blank
 *   2) node shot.mjs
 *
 * 说明：截图前会注入演示账号 token 到 localStorage（键 pt_token），
 *       以便截取登录后的主界面。
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = path.resolve('docs/screenshots');
const BASE = 'http://localhost:8080';
const TOKEN = process.env.PT_TOKEN || '';

const WIDTH = 1440;
const HEIGHT = 900;
const DPR = 2; // 2x 保证 README 里清晰

fs.mkdirSync(OUT, { recursive: true });

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${CDP}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('无法连接 Chrome 调试端口 9222，请先启动 Chrome');
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new Session(ws);

  // 新建一个独立标签页，避免与已有页面互相干扰
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  // 禁用 HTTP 缓存，保证每次截到的是最新构建
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: DPR,
    mobile: false,
  }, sessionId);

  /** 导航到 url，等待网络空闲后再额外等 ms 让图表/接口渲染完成 */
  async function shot(url, file, waitMs = 2500, fullPage = false) {
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(waitMs);
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(path.join(OUT, file), buf);
    console.log(`  ✓ ${file}  (${url})  ${(buf.length / 1024).toFixed(0)} KB`);
  }

  // ---------- 1) 未登录：登录页 ----------
  console.log('[1/2] 登录页（未登录态）');
  await shot(`${BASE}/`, 'login.png', 2500);

  if (!TOKEN) {
    console.log('未提供 PT_TOKEN，跳过登录后页面');
    ws.close();
    return;
  }

  // ---------- 2) 注入 token 后截取主界面 ----------
  console.log('[2/2] 登录后主界面');
  await cdp.send('Page.navigate', { url: `${BASE}/market` }, sessionId);
  await sleep(1200);
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('pt_token', ${JSON.stringify(TOKEN)}); 'ok'`,
  }, sessionId);
  await sleep(300);

  const shots = [
    ['/market', 'market.png', 4000],
    ['/stock/600519', 'stock-detail.png', 4500],
    ['/portfolio', 'portfolio.png', 5000],
    ['/leaderboard', 'leaderboard.png', 3500],
    ['/transactions', 'transactions.png', 3000],
    ['/profile', 'profile.png', 3000],
    ['/watchlist', 'watchlist.png', 3000],
  ];
  for (const [p, f, w] of shots) {
    await shot(`${BASE}${p}`, f, w);
  }

  ws.close();
  console.log(`\n全部完成，输出目录：${OUT}`);
}

main().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
