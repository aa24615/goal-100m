# 赚一个小目标 - 模拟股票

一套**纯前端 + 后端 + 数据库**全栈的 **A 股风格网页模拟炒股系统**，支持多用户注册登录、实时模拟行情、买卖撮合、持仓盈亏与全市场收益排行榜。零风险练盘感，注册即赠 ¥1,000,000 虚拟资金。

> **真实 A 股行情 + 模拟资金与模拟交易**：行情为真实 A 股公开数据（东方财富优先、新浪兜底，仅供学习研究），资金、持仓与成交为模拟撮合，不涉及任何真实证券业务，不构成投资建议。

## 界面预览

| 登录 | 行情中心 |
| --- | --- |
| ![登录页](docs/screenshots/login.png) | ![行情中心](docs/screenshots/market.png) |
| **个股详情**（真实 K 线 + 交易面板） | **我的持仓**（资产曲线 + 分账） |
| ![个股详情](docs/screenshots/stock-detail.png) | ![我的持仓](docs/screenshots/portfolio.png) |
| **收益排行榜**（五周期榜） | **交易记录** |
| ![收益排行榜](docs/screenshots/leaderboard.png) | ![交易记录](docs/screenshots/transactions.png) |
| **自选股** | **个人资料**（头像/密码/重置） |
| ![自选股](docs/screenshots/watchlist.png) | ![个人资料](docs/screenshots/profile.png) |

## 功能一览

- **多用户系统**：邮箱 + 密码注册/登录，JWT 鉴权，每人独立账户与持仓。
- **真实 A 股数据**：接入东方财富 + 新浪双行情源（带熔断与自动恢复），覆盖 **全市场 5500+ 只真实标的**（沪深主板 / 创业板 / 科创板 / 北交所）、**上市以来真实历史日线**（537 万根 K 线），盘中按真实快照驱动价格，WebSocket 每 2 秒推送。
- **行情中心**：全市场列表，支持搜索、按行业筛选、涨跌幅排序、一键加自选。
- **个股详情**：分时走势图（ECharts），实时报价、今开/昨收/最高/最低。
- **交易**：买入/卖出，A 股风格费用（佣金万3 最低5元、卖出印花税万5、过户费万0.1），资金与持仓原子更新。
- **我的持仓**：总资产、可用资金、持仓市值、总收益率，逐标的盈亏。
- **资产曲线与账户分账**：按自然日聚合的净值曲线，可切换 **总资产 / 收益额 / 收益率** 三种指标与 **7/30/90天/全部** 区间；账户拆分为 **资金账户（可用现金）** 与 **交易账户（持仓市值）** 双账户并标注占比；附最大回撤。日级点数不足时自动回退到「今日分时」分钟级曲线。
- **交易记录**：分页查询历史成交。
- **收益排行榜**：**周榜 / 月榜 / 季榜 / 年榜 / 总榜** 五种周期切换，按各周期收益率排名，前三高亮。
- **多标签页**：顶部标签栏可同时打开多个页面（如多只个股详情），支持点击切换、单个关闭、关闭其他 / 全部；「行情中心」固定不可关，刷新后自动恢复已打开的标签。

## 交易规则

- **涨跌停**：按板块，见下表（分板块 ident 规则在 `backend/src/rules.js`）

  | 板块 | 代码前缀 | 幅度 |
  | --- | --- | --- |
  | 主板 | 60 / 00 及其余 | ±10% |
  | 创业板 | 300 / 301 | ±20% |
  | 科创板 | 688 / 689 | ±20% |
  | 北交所 | 43 / 83 / 87 / 88 / 920 | ±30% |
  | 主板风险警示（ST / \*ST） | 名称含 ST | ±5% |

  涨停不能买、跌停不能卖；**新股上市前 5 个交易日无涨跌幅限制**。
- **停牌 / 退市（RQ-50）**：`trade_status = HALTED | DELISTED` 的标的一律拒单；无有效报价、或「零成交且价格未变动」的标的也判定为停牌，拒绝时给出机器可读 `rule` 与中文原因。
- **T+1**：当日买入的股份次日方可卖出（`T1_ENABLED=0` 可关闭）
- **报价保护**：下单携带客户端展示价，偏离服务端成交价超过 `PRICE_TOLERANCE`（默认 0.5%）时拒绝并要求确认新价
- **成本价含费**：建仓/加仓把佣金摊入成本；卖出按摊薄成本计算已实现盈亏并落库 `realized_pnl`
- **委托方式**：市价即时成交 + **限价委托**（达到委托价自动撮合，可撤单）
- **交易时段**：默认**真实时钟模式**（9:30-11:30 / 13:00-15:00，节假日休市，盘前展示上一交易日收盘行情与真实涨跌）；`REAL_CLOCK=0` 可切换为压缩模式（一个交易日 = 120 个 tick）

## 缺陷修复对照（产品需求表 35 项）

| 级别 | 修复内容 |
| --- | --- |
| P0 | 交易日收盘结算滚动昨收(D01)、隔夜跳空开盘(D02)、交易时段与休市(D03)、报价锁定与偏离校验(D04)、T+1 冻结(D05)、涨跌停撮合约束(D06) |
| P1 | 市值加权指数(D07)、自选股后端持久化(D08)、持仓行锁防超卖(D09)、成本价含费(D10)、费率后端统一下发(D11)、生产环境禁用默认 JWT 密钥(D12)、接口限流(D13)、CORS 白名单(D14)、WebSocket 鉴权与心跳(D15)、行情持久化日线(D16)、成交量由成交驱动(D17)、open_price 随开盘更新(D18)、已实现盈亏字段(D19)、排行榜单 SQL+缓存(D20)、超额收益基准(D21)、账号大小写归一化(D22)、重置模拟账户(D24)、净值曲线(D25) |
| P2 | 批量落库(D32)、健康检查与优雅关闭(D33)、前端可用资金/可卖数量校验与快捷仓位(D27)、统一服务端 tick 时间(D28)、tick 渲染节流(D29)、注册校验加强(D30)、401 走 logout(D31)、登录/注册 loading 拆分(D34)、限价委托与撤单(D35) |

> 说明：D23（邮箱找回密码）需要 SMTP 服务，当前未接入——已移除误导性文案，并提供「修改密码」与「重置模拟账户」两个替代入口；D26（移动端深度适配）做了侧边栏断点与头部换行的基础适配，完整移动端改造待后续。

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
│       ├── market.js       # 行情引擎（真实快照驱动） + 实时推送
│       ├── datasource/     # 行情数据源：东方财富 + 新浪（多源容灾、熔断）
│       ├── scripts/        # syncMarket.js 全量同步（标的池 + 历史日线）、migrate.js
│       ├── services/       # 业务层：trade / portfolio / leaderboard / equity 等
│       ├── logger.js       # 结构化日志：分级、轮转、落盘
│       ├── middleware.js   # 请求日志 / 404 / 异常兜底 / asyncHandler
│       └── routes/         # market / trade / leaderboard 等薄路由
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

首次启动会自动建表并执行迁移；随后需**同步一次真实行情数据**（全市场标的 + 历史日线，约 3 分钟）：

```bash
cd backend
DATABASE_URL=postgresql://papertrade:papertrade@localhost:5433/papertrade npm run sync:market
```

容器内的后端则无需手动执行（可 `docker compose exec backend node src/scripts/syncMarket.js`）。

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

- **仅做 A 股**：红涨绿跌、万3 佣金+印花税+过户费、沪深/创业板/科创板代码风格。
- **涨跌停按板块（RQ-49）**：主板 ±10%、创业板/科创板 ±20%、北交所 ±30%、主板 ST ±5%，新股上市前 5 个交易日无涨跌幅限制。规则集中在 `backend/src/rules.js`（纯函数，可单测），下单、限价撮合、回放、双盲四条链路共用同一口径。
- **视觉风格**：清新青绿（teal `#0ea5a4`）主题 + 浅色侧边栏。涨跌沿用 A 股「红涨绿跌」，但**仅用于数字着色**且色调调柔，界面无大面积红色（卖出/删除等按钮也已去红）。
- **T+1（默认开启）**：当日买入的股份当日不可卖，`T1_ENABLED=0` 可关闭。T+0 仅在关闭该开关时出现，不是默认行为。
- **行情为真实数据**：标的池、历史 K 线与盘中价格均来自公开行情（东方财富优先、新浪兜底）；断网或数据源全部不可用时，页面沿用最近一次真实价格，不凭空生成。
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

- **改了标的池？** 标的池由真实数据源自动同步（`npm run sync:market`），无需手工维护；新上市股票重跑同步即可入库。
- **行情没在动？** 默认真实时钟模式，非交易时段（含周末/节假日/盘前）价格保持上一交易日收盘，开盘后随真实行情变动。
- **重置数据？** `docker compose down -v` 删除卷后重新 `up`。
