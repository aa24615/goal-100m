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

## 发布流程（必读 · RQ-87）

本项目已两次出现「生产代码 ≠ 仓库代码」：功能在仓库里、单测全绿，但线上跑的是旧镜像，
新接口全量 404。根因是**发布链路没有固化**，因此这三步是硬约束，顺序不可颠倒：

```bash
# ① 提交并推送双远端（GitHub + CNB）
git add -A && git commit -m "..." && git push origin main

# ② 在宿主机重新构建前端 —— 镜像只 COPY 本机 dist，不重新 build 等于没改
cd frontend && npm run build && cd ..

# ③ 重建并启动容器
docker compose up -d --build

# ④ 发布后验证（RQ-123）—— 不验证就不算发布完成
cd backend && node src/scripts/verifyRelease.js
```

发布前**必须**执行一致性检查，不通过就不要发：

```bash
cd backend && npm run release:check
```

它会校验：工作区是否干净、HEAD 是否已推送到全部远端、`dist` 资源是否完整且**不落后于源码**、
迁移是否全部应用、README 是否写明发布三步。任一项失败即以退出码 1 阻断。

发布后**必须**跑验证清单——v7 断在「提交未部署」、v10 断在「写完未提交」，两次都是发完之后没人验证：

```bash
cd backend && node src/scripts/verifyRelease.js --json
```

六项断言，任一失败即退出码 1：

| # | 断言 | 判据 |
|---|---|---|
| 1 | `bundle-name` | 线上加载的 bundle 文件名 = 本地 `dist` 文件名（防止仍在跑旧包） |
| 2 | `migration` | 生产 `schema_migrations` 含最新迁移版本 |
| 3 | `routes` | 本期新增路由状态码符合预期（需登录的端点 401 即可，404 才是没发上去；已下线路由须 410） |
| 4 | `telemetry` | 埋点**真的落库**——写入一条探针再删除，只看接口返回 200 不算数 |
| 5 | `errors` | 发布后 `frontend_errors` 新增 0 条 |
| 6 | `error-logs` | 发布后后端日志新增 ERROR 0 条 |

## 公网入口（RQ-122）

> **当前状态：未配置。** 唯一入口是本机 `http://localhost:8080`，外部设备打不开。
> 在公网入口就绪前，获客、留存、首训转化三项在物理上都不可执行——分享链接发出去别人打不开。

配置步骤：

1. 准备域名。没有自有域名时可用免费泛解析过渡域名（把公网 IP 编进域名），先跑通再换正式域名：

   ```bash
   curl "http://localhost:8080/api/public/access?ip=你的公网IP"
   # → suggestion.domain / suggestion.env 给出可直接使用的域名与 .env 行
   ```

2. 在 `.env` 写入唯一对外地址：

   ```bash
   PUBLIC_BASE_URL=https://你的域名
   ```

3. 让反代以该域名提供 HTTPS（HTTP 一律 301 跳 HTTPS）。配置片段可直接取：

   ```bash
   curl http://localhost:8080/api/public/access/nginx
   curl http://localhost:8080/api/public/access/env
   ```

4. 自检（无需登录，部署机上直接 curl）：

   ```bash
   curl http://localhost:8080/api/public/access
   ```

   返回 `ready: true`、`blockers: []` 才算具备公网可达性；`checklist` 给出逐项完成情况，
   `nextAction` 给出下一步该做什么。**localhost 与内网段一律判为不可对外**——防止自欺。

5. **RQ-142 新增：三处文件一致性自检。**
   前四版「未完成」的根因是没人去读那三个文件，大家读的是上一版需求文档里的结论。
   现在发布前检查会直接解析 `.env` / `frontend/nginx.conf` / `README.md` 并列出缺项：

   ```bash
   npm run release:check     # 输出 [WARN] public-entrypoint: 公网入口未就绪（缺哪几项）
   ```

   判定项：`.env` 是否配了 https 的 `PUBLIC_BASE_URL`、nginx `server_name` 是否仍为 `_`、
   是否配置了 HTTP 301 跳 HTTPS、是否监听 443 ssl、README 是否写明公网地址。

6. **RQ-145 新增：双远端同步校验。**
   `git push origin main` 会同时推送 GitHub 与 CNB，但任一侧失败都会留下「一份提交只在一个远端」。
   发布前检查新增 `remote-parity` 项，两个远端 HEAD 不同哈希即阻断发布。

## 结算口径说明书（RQ-150 / RQ-151）

> 模拟盘最容易被怀疑的是「这个成交价是不是假的」。一旦怀疑成立，训练价值归零。
> 因此每一笔成交都摊开可核对，而不是让用户选择相信我们。

**注意命名**：这里的「结算口径说明书」**不是** L2 行情的「逐笔成交明细」。
竞品语境里的逐笔 = 逐笔委托/成交盘口，我们给的是「这一笔模拟成交的价和费怎么算出来的」。

三处入口（RQ-151，此前只在成绩区里，用户找不到 → F-82）：

| 位置 | 入口 |
|---|---|
| 训练页 `/training` | 「结算口径说明书」卡片，直接跳最近一局 |
| 复盘页 `/review` | 同卡片（紧凑模式） |
| 训练成绩区 `/blind` | 完整面板：逐笔展开 + 拒绝归类 + CSV 导出 |

每一笔成交可展开回答三个问题（RQ-150）：

1. **为什么是这个价？** —— 撮合价 = 该根已揭示 K 线的收盘价，指认到具体第几根；出现偏离即标红。
2. **扣了多少费？** —— 佣金 / 印花税 / 过户费逐项，最低佣金是否触发，并与按公开费率重算的结果比对。
3. **为什么被拒？** —— 被拒绝的委托归类到规则条款（T+1 / 涨跌停 / 整手 / 资金不足…），
   给出「怎么自己核对」与「下一步怎么做」。

与真实规则的差异清单（≥5 条）可一键复制，也可导出 CSV（含成交与拒绝两类）。

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/blind/1/settlement/audit
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/blind/1/settlement/audit?format=csv"
```

自检三项（`audit.priceMismatch` / `feeMismatch` / `unknownRejections`）全为 0 时，
本局才可声称「逐笔可核对」；任何一项不为 0 都会在页面上说出来，而不是藏进日志。

## 数据保留期承诺（RQ-154）

| 身份 | 保留期 |
|---|---|
| 登录用户 | **永久保留**（训练记录、成绩卡、结算明细不会因时间自动删除） |
| 游客 | **7 天**，第 5 天起在训练页与注册页提醒转登录 |

训练记录可随时导出为 CSV（含「有效完成」列，能区分空跑与真实训练）：

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/blind/export?format=csv"
```

竞品 8 家无一明确保留期；保留期短是隐性劝退点（用户不敢投入三个月）。因此这条承诺写在
**用户投入之前**（注册页与训练页均可见），而不是藏在条款里。

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
