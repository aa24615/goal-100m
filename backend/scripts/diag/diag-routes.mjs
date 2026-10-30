// 用途：枚举生产镜像内 Express 已注册的全部路由（方法 + 路径），用于核对「镜像是否含最新代码」。
// 运行：docker exec -i mm8888-backend-1 node --input-type=module < backend/scripts/diag/diag-routes.mjs
// 注意：脚本 import 的是容器内绝对路径 /app/src/index.js，**只在容器内运行**。
// 诊断脚本：枚举 Express 全部路由（方法 + 路径 + 参数占位）
// 用法：docker exec -i <backend容器> node --input-type=module < scripts/diag-routes.mjs
import { createApp } from '/app/src/index.js';

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const p = prefix + layer.route.path;
      for (const m of Object.keys(layer.route.methods)) out.push([m.toUpperCase(), p]);
    } else if (layer.name === 'router' && layer.handle.stack) {
      const m = layer.regexp.source
        .replace('^\\/', '')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '')
        .replace(/\?\(\?=\/\|\$\)$/, '');
      let seg = '';
      try {
        seg = m.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, '*');
      } catch {
        seg = '*';
      }
      walk(layer.handle.stack, prefix + (seg && seg !== '^' ? '/' + seg.replace(/^\/+/, '') : ''), out);
    }
  }
}

const app = createApp();
const out = [];
walk(app._router ? app._router.stack : [], '', out);
const uniq = [...new Set(out.map((x) => x.join(' ')))].sort();
for (const r of uniq) console.log(r);
console.error('TOTAL=' + uniq.length);
process.exit(0);
