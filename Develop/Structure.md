# Structure.md: Repository Structure (Uptimer)

本文定义 Uptimer 仓库的目录结构、模块边界与命名约定，用于初始化与后续协作一致性。

---

## 1. 顶层目录（当前）

```
.
├─ apps/
│  ├─ web/                      # Cloudflare Pages: React + Vite 前端（管理后台 + 公共状态页）
│  └─ worker/                   # Cloudflare Workers: Hono API + scheduled 监控引擎
├─ packages/
│  ├─ shared/                   # 共享类型/常量/Zod schema（前后端共用）
│  └─ db/                       # Drizzle schema 与 DB 访问封装（供 worker 使用）
├─ Develop/                     # 产品规格、结构、计划、API 参考、发布记录
├─ .github/workflows/           # CI/CD（Pages + Worker 部署、D1 迁移）
├─ AGENTS.md                    # 代码助手/协作约定
└─ reference-project/           # 参考项目（只读；不要在此处开发）
```

说明：

- 本仓库采用 monorepo 结构，便于共享类型与统一依赖。
- 规格文档统一放在 `Develop/`；Issue #24 CPU release 记录见 `Develop/Worker-CPU-10ms-Release-Readiness.md`。
- 只读参考项目仅作为 Cloudflare API/Workers 用法参考；本项目实现应以 `Develop/Application.md` 为准。

---

## 2. Worker（后端）结构

```
apps/worker/
├─ wrangler.toml                # Worker 配置（D1 binding、cron triggers、Free Plan CPU profile）
├─ migrations/                  # D1 SQL migrations（wrangler d1 migrations apply）
└─ src/
   ├─ index.ts                  # Worker entry：fetch/scheduled/export default
   ├─ fetch-handler.ts          # fetch 入口拆分，降低 scheduled cold path 负担
   ├─ hono-app.ts               # Hono app 与路由挂载
   ├─ env.ts                    # Env interface（D1 binding、secrets、feature flags）
   ├─ analytics/                # latency / uptime 聚合 helpers
   ├─ internal/                 # scheduled/service-binding internal handlers
   │  ├─ homepage-refresh-core.ts
   │  ├─ runtime-fragments-refresh-core.ts
   │  ├─ sharded-public-snapshot-core.ts
   │  └─ sharded-public-snapshot-continuation.ts
   ├─ middleware/               # auth / errors / public cache / rate limit
   ├─ routes/
   │  ├─ public.ts              # /api/v1/public/*（完整 public API）
   │  ├─ public-hot.ts          # homepage/status/artifact hot snapshot path
   │  ├─ public-ui*.ts          # status UI 辅助 API
   │  ├─ admin*.ts              # admin CRUD / settings / analytics / exports
   │  └─ ...
   ├─ scheduler/
   │  ├─ scheduled.ts           # scheduled() 编排、check-batch children、CPU profile
   │  ├─ daily-rollup.ts        # monitor_daily_rollups
   │  ├─ lock.ts / lease-guard.ts
   │  ├─ notifications.ts
   │  └─ retention.ts
   ├─ monitor/                  # HTTP/TCP check、target validation、state machine
   ├─ notify/                   # Webhook dispatch、template、dedupe
   ├─ observability/            # trace/timing helpers（diagnostics 默认关闭）
   ├─ public/                   # homepage/status payload compute、runtime snapshot、visibility
   ├─ schemas/                  # Zod schemas for public/admin/stored payloads
   └─ snapshots/                # public_snapshots read/write, fragments, homepage artifact
```

约定：

- 所有对外 API 均从 `routes/` 进入；非路由逻辑沉到 `public/`、`snapshots/`、`internal/`、`scheduler/` 等模块。
- `scheduled()` 入口仅负责编排流程与日志；探测、runtime fragment 写入、sharded public snapshot publish 拆为小 invocation。
- `internal/` routes 仅由 scheduled/service binding 使用，必须保持 Bearer Token 鉴权与 feature flag gating。

---

## 3. Web（前端）结构

```
apps/web/
├─ public/
├─ index.html
├─ vite.config.ts
└─ src/
   ├─ main.tsx
   ├─ app/
   │  ├─ router.tsx             # React Router 路由表
   │  └─ queryClient.ts         # TanStack Query 配置
   ├─ api/
   │  ├─ client.ts              # fetch 封装（baseUrl、错误处理）
   │  └─ types.ts               # 前端 API 类型（优先从 packages/shared 导入）
   ├─ pages/
   │  ├─ StatusPage.tsx         # 公共状态页
   │  ├─ AdminLogin.tsx         # 可选（仅 Token 输入/保存到 localStorage）
   │  └─ AdminDashboard.tsx
   ├─ features/
   │  ├─ monitors/              # 监控项 CRUD UI
   │  ├─ incidents/             # 事件管理 UI
   │  └─ notifications/         # 通知渠道 UI
   ├─ components/
   ├─ styles/
   └─ utils/
```

约定：

- 与后端共享的类型与 schema 优先从 `packages/shared` 导入，避免前后端“各写一套”。
- API 请求统一走 `api/client.ts`；不要在组件内散落裸 `fetch`。

---

## 4. Shared/DB 包结构

```
packages/shared/
└─ src/
   ├─ constants.ts              # 枚举/常量（status、event type）
   ├─ schemas.ts                # Zod schemas（API input/output、DB json 字段）
   └─ types.ts                  # TypeScript 类型（由 schema 推导）

packages/db/
└─ src/
   ├─ schema.ts                 # Drizzle table schema（与 migrations 一致）
   └─ index.ts                  # 导出 db helpers
```

约定：

- DB schema（Drizzle）与 D1 migrations（SQL）必须同步变更；任何 schema 改动必须伴随新增 migration。
- `config_json`、`*_json` 字段统一使用 Zod 做运行时校验。

---

## 5. 命名与边界规则

- 路由：
  - Public: `/api/v1/public/*`
  - Admin: `/api/v1/admin/*`
- 时间字段：
  - 对外 API 与 D1 存储统一使用 unix seconds（INTEGER），字段名以 `*_at` 结尾。
- 状态字段：
  - DB/接口统一用 `up|down|maintenance|paused|unknown`；延迟统一用 `latency_ms`。
- 不允许在 `apps/web` 直接依赖 Worker 运行时 API（如 `cloudflare:sockets`）。
- 不允许修改只读参考项目作为实现的一部分（除非明确要求）。
