# 赚他一个小目标 - 模拟股票

一套**纯前端 + 后端 + 数据库**全栈的 **A 股风格网页模拟炒股系统**，支持多用户注册登录、实时模拟行情、买卖撮合、持仓盈亏与全市场收益排行榜。零风险练盘感，注册即赠 ¥1,000,000 虚拟资金。

> 所有行情、资金、交易均为**虚拟仿真**，不涉及任何真实证券业务。

## 功能一览

- **多用户系统**：邮箱 + 密码注册/登录，JWT 鉴权，每人独立账户与持仓。
- **实时行情引擎**：后端以随机游走（GBM 风格）模拟 28 只 A 股标的，每 2 秒一个 tick，含 ±10% 涨跌停限制，通过 WebSocket 实时推送。
- **行情中心**：全市场列表，支持搜索、按板块筛选、涨跌幅排序、一键加自选。
- **个股详情**：分时走势图（ECharts），实时报价、今开/昨收/最高/最低。
- **交易**：买入/卖出，A 股风格费用（佣金万3 最低5元、卖出印花税万5、过户费万0.1），资金与持仓原子更新。
- **我的持仓**：总资产、可用资金、持仓市值、总收益率，逐标的盈亏。
- **交易记录**：分页查询历史成交。
- **收益排行榜**：**周榜 / 月榜 / 季榜 / 年榜 / 总榜** 五种周期切换，按各周期收益率排名，前三高亮。
- **多标签页**：顶部标签栏可同时打开多个页面（如多只个股详情），支持点击切换、单个关闭、关闭其他 / 全部；「行情中心」固定不可关，刷新后自动恢复已打开的标签。

## 技术架构

| 层 | 技术 |
| --- | --- |
| 前端 | React 18 + Vite + TypeScript + Ant Design 5 + ECharts |
| 后端 | Node.js (ESM) + Express + PostgreSQL(`pg`) + WebSocket(`ws`) + JWT + bcrypt |
| 数据库 | PostgreSQL 15 |
| 部署 | Docker Compose：三服务 `db` / `backend` / `frontend`(nginx) |

### 目录结构

```
.
├── docker-compose.yml      # 编排 db / backend / frontend
├── db/init.sql             # 数据库表结构初始化（首次启动自动执行）
├── backend/                # Node 后端
│   ├── Dockerfile
│   └── src/
│       ├── index.js        # 入口：HTTP + WS + 启动行情
│       ├── db.js           # pg 连接池
│       ├── auth.js         # 注册/登录/me，JWT 中间件
│       ├── market.js       # 行情模拟引擎 + 实时推送
│       ├── seed.js         # 初始股票池
│       ├── logger.js       # 结构化日志：分级、轮转、落盘
│       ├── middleware.js   # 请求日志 / 404 / 异常兜底 / asyncHandler
│       └── routes/         # market / trade / leaderboard
└── frontend/               # React 前端
    ├── Dockerfile          # 直接 COPY 已构建的 dist + nginx（构建期无需联网）
    ├── nginx.conf          # /api 与 /ws 反向代理
    └── src/
        ├── api.ts          # axios 封装
        ├── ws.ts           # 全局行情订阅
        ├── auth.tsx        # 登录态上下文
        ├── components/     # 图表、交易面板
        └── pages/          # 登录/行情/详情/自选/持仓/记录/排行
```

## 快速开始（Docker）

> 需已安装 Docker 与 Docker Compose。

```bash
# 1. 克隆/进入项目目录
cd mm8888

# 2. 先在宿主机安装依赖并构建前端
#    （两个 Dockerfile 采用「COPY 本机产物」的离线构建方案，构建期不联网；
#      node_modules 与 dist 已在 .gitignore 中排除，故 clone 后需本地生成一次）
cd backend  && npm install && cd ..
cd frontend && npm install && npm run build && cd ..

# 3.（可选）设置 JWT 密钥
cp .env.example .env
# 编辑 .env 修改 JWT_SECRET

# 4. 一键构建并启动
docker compose up -d --build

# 5. 查看状态
docker compose ps
```

启动完成后访问：**http://localhost:8080**

- 前端（nginx）：`8080 → 80`
- 后端 API：`/api`，WebSocket：`/ws`（均由 nginx 代理，无需单独暴露）
- PostgreSQL：仅容器内网可访问，数据持久化于 `pgdata` 卷

首次启动会自动建表并灌入 28 只模拟标的；后端会等待数据库健康后开始播种与行情。

## Docker Hub 不可达时（国内镜像）

若所在网络无法直连 `registry-1.docker.io`，可改用国内加速镜像拉取基础镜像并打回标准 tag。
本项目的 `Dockerfile` 已改为**直接 COPY 本机已安装好的 `node_modules` 与已构建的 `dist`**（构建期零网络依赖）：

```bash
# 用 1ms.run 镜像源拉取并重新打标准 tag（保持 postgres:15-alpine / node:20-alpine / nginx:alpine）
docker pull docker.1ms.run/library/postgres:15-alpine && docker tag docker.1ms.run/library/postgres:15-alpine postgres:15-alpine
docker pull docker.1ms.run/library/node:20-alpine      && docker tag docker.1ms.run/library/node:20-alpine      node:20-alpine
docker pull docker.1ms.run/library/nginx:alpine         && docker tag docker.1ms.run/library/nginx:alpine         nginx:alpine

# 镜像就绪后即可正常构建启动
docker compose up -d --build
```

> 备选镜像源：`docker.cnb.cool/php127/docker/...` 等。

## 本地开发（不依赖 Docker）

**后端**
```bash
cd backend
npm install
DATABASE_URL=postgresql://user:pass@localhost:5432/papertrade npm start
```

**前端**
```bash
cd frontend
npm install
npm run dev      # 默认 http://localhost:5173，已配置 /api 与 /ws 代理到 :3001
```

## 设计说明（我的取舍）

- **仅做 A 股**：红涨绿跌、万3 佣金+印花税+过户费、沪深/创业板/科创板代码风格、±10% 涨跌停。
- **视觉风格**：清新青绿（teal `#0ea5a4`）主题 + 浅色侧边栏。涨跌沿用 A 股「红涨绿跌」，但**仅用于数字着色**且色调调柔，界面无大面积红色（卖出/删除等按钮也已去红）。
- **T+0 练习模式**：为了演示流畅，默认允许当日买卖（真实 A 股为 T+1）。如需更严格仿真，可在 `backend/src/routes/trade.js` 增加买入日冻结逻辑。
- **行情为随机游走**：离线可跑，不依赖任何外部行情 API；初始历史分时由引擎在启动时生成。
- **初始资金**：¥1,000,000，定义在 `backend/src/auth.js` 的 `INITIAL_CAPITAL`。
- **周期榜基准**：周 / 月 / 季 / 年榜以「周期起点前最近的一条资产快照」为期初资产，收益率 =（当前总资产 − 期初资产）÷ 期初资产。后端每分钟记录一次快照（`SNAPSHOT_MS` 可调）。若该周期尚无快照则退回初始资金，因此刚部署时各周期榜会暂时与总榜一致，随时间累积会自然分化。容器已设 `TZ=Asia/Shanghai`，保证周一 / 月初按国内时间界定。

## 日志与排错

后端内置**零依赖结构化日志**，请求、业务失败、异常堆栈全部落盘并通过卷持久化到宿主机。

**位置**：`backend/logs/`（容器 `/app/logs` 已挂载，重启不丢）

| 文件 | 内容 |
| --- | --- |
| `app-YYYY-MM-DD.log` | 全量日志（info / warn / error / debug） |
| `error-YYYY-MM-DD.log` | 仅 error，含完整堆栈，故障优先看这个 |

**会记录什么**
- 每个 HTTP 请求：方法、路径、状态码、耗时(ms)、IP、用户 ID、`requestId`（5xx 记 error，4xx 记 warn）
- 业务失败：注册重复、登录失败、资金不足、持仓不足、股票不存在、鉴权失败等（warn）
- 未捕获异常：完整堆栈 + 请求上下文（error）
- 进程级：`uncaughtException`、`unhandledRejection`、启停信号
- 行情引擎：tick 异常、行情落库失败（单次异常不会中断定时器）

**格式**：每行一个 JSON，便于 grep / 采集

```json
{"ts":"2026-10-20T16:11:51.609Z","level":"WARN","msg":"买入失败: 可用资金不足","userId":2,"code":"600519","quantity":999999,"need":1660983084.72,"cash":1000000}
```

**常用命令**

```bash
tail -f backend/logs/app-*.log        # 实时看全量
tail -f backend/logs/error-*.log      # 只看错误
grep '资金不足' backend/logs/app-*.log # 按关键词检索
grep 'requestId' backend/logs/app-*.log | grep 'a1b2c3d4'  # 追踪单次请求
docker compose logs -f backend        # 容器控制台输出（同源，实时彩色）
```

**环境变量**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug` 会额外打印每次行情推送 |
| `LOG_DIR` | `/app/logs`（容器内） | 日志目录 |
| `LOG_MAX_SIZE` | `10485760` | 单文件超过该字节数自动轮转（10MB） |
| `LOG_MAX_ROTATED` | `5` | 轮转保留份数 |
| `LOG_RETENTION_DAYS` | `14` | 历史日志保留天数，启动时自动清理 |

> **安全**：请求体里的 `password` / `token` / `secret` / `authorization` 等敏感字段会自动脱敏为 `***`，不会明文写入日志。

## 常见问题

- **改了股票池？** 编辑 `backend/src/seed.js` 的 `STOCKS` 数组；仅在表为空时播种，已存在则需清空 `stocks` 表后重启。
- **行情太慢/太快？** 通过环境变量 `TICK_MS`（毫秒）调整，默认 2000。
- **重置数据？** `docker compose down -v` 删除卷后重新 `up`。
