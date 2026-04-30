# Application.md: Uptimer

Version: 0.1.0 (Draft, revised)
Type: Technical Specification & Application Architecture
Platform: Cloudflare Native (Workers + Pages + D1)
Last updated: 2026-01-28

---

## 0. 读者与范围

本文用于项目初始化阶段的技术规格说明，目标是把 Uptimer 的「做什么 / 不做什么 / 怎么做 / 数据如何落地 / API 如何对外」一次性讲清楚，便于后续拆分任务与实现。

本文默认单租户（一个站点由一个团队/个人维护），多租户属于后续扩展。

---

## 1. 项目概述 (Executive Summary)

Uptimer 是一个构建在 Cloudflare 边缘网络上的 Serverless 可用性监控 + 状态页 + 事件管理平台。

核心目标：

- Zero-Ops：无服务器、无容器、无自建数据库实例。
- Cloudflare-native：Workers 负责 API 与定时探测；Pages 承载 Web UI；D1 存储配置与历史数据。
- 开箱即用：以「个人/中小团队」的可维护性、低成本、可定制为优先。

差异化强调（需与 Cloudflare 运行时约束匹配）：

- “Edge-first” 的真实含义：探测从 Cloudflare 运行环境发起（非传统单机 VPS），但 Cron Trigger 并不保证在所有边缘节点运行；如需多地域探测，需要额外的“多探针”设计（见 6.7 与 15）。

---

## 2. 目标与非目标 (Goals / Non-goals)

### 2.1 目标 (Goals)

- 支持 HTTP(S) 与 TCP 探测；提供可配置的超时、重试、断言与告警节流。
- 提供公共状态页（聚合状态 + 组件列表 + 历史事件）。
- 提供管理后台（监控项管理、事件管理、通知渠道配置、系统设置）。
- 数据可追溯：保留必要的探测记录用于图表、SLA 计算、审计与问题回溯，同时控制 D1 体积增长。

### 2.2 非目标 (Non-goals, v0.x)

- 不做完整 APM、链路追踪、日志平台。
- 不追求 ICMP 原生 Ping（Workers 运行时不提供标准 ICMP）。统一使用 Latency 指标，以 HTTP fetch / TCP connect 近似实现。
- 不做复杂 RBAC/多租户计费；v0.x 固定为“单租户 + 单管理员 Token”。

---

## 3. 关键约束与设计原则 (Constraints & Principles)

### 3.1 Cloudflare Workers 约束（对设计有直接影响）

- Cron Triggers 通过 `scheduled()` 事件触发；按 wrangler/Dashboard 配置的 cron 表达式运行（UTC），触发时间可能存在抖动/漂移，且不保证在所有边缘节点执行。参考：Workers Cron Triggers 文档。
- 出站探测要避免被 Cloudflare 缓存影响：对 HTTP 探测请求显式禁用缓存（见 6.2）。
- TCP 探测需使用 Workers 的 TCP Socket API：`import { connect } from 'cloudflare:sockets'`（见 6.3）。该能力仅支持出站 TCP，不等同于 ICMP。
- 需要控制并发：Workers 对并发出站连接存在运行时限制，需做并发上限（例如默认 5）以避免资源耗尽与不稳定。

### 3.2 数据库（D1/SQLite）约束

- D1 本质是 SQLite 语义，适合中等规模结构化数据；高频写入必须配合数据保留策略（Retention）与必要的聚合/归档，否则表会快速膨胀。
- 读写都需要走 D1 binding API（`env.DB.prepare(...).bind(...).run()` 等），尽量使用参数化 SQL 防注入。参考：D1 prepared statements 文档。

### 3.3 设计原则

- “可实现优先”：v0.x 先把 HTTP/TCP、告警、状态页、事件跑通，避免过度设计。
- “可扩展不绑死”：数据模型与 API 预留多地域探测、更多通知渠道、更多图表维度的扩展点。
- “安全默认”：后台鉴权、输入校验、SSRF/端口扫描滥用防护要在第一版就设计进来。

---

## 4. 技术栈 (Tech Stack)

Frontend (Dashboard + Status Page):

- Host: Cloudflare Pages
- Framework: React + Vite (TypeScript)
- Styling: Tailwind CSS
- Router: React Router
- Data Fetching: TanStack Query
- Forms/Validation: React Hook Form + Zod
- Charts: Recharts

Backend (API + Scheduler):

- Host: Cloudflare Workers
- Triggers: HTTP (`fetch`) + Cron (`scheduled`)
- Language: TypeScript
- Routing: Hono
- Validation: Zod
- Concurrency control: p-limit (cap outbound checks)

Storage:

- Core DB: Cloudflare D1
- SQL/ORM: Drizzle ORM (D1/SQLite driver)
- Migrations: SQL migrations managed via Wrangler (`wrangler d1 migrations`)

---

## 5. 系统架构 (System Architecture)

### 5.1 组件划分

- Pages Web：公共状态页 + 管理后台 UI。
- Worker API：对外 REST API（public/admin），聚合 D1 数据。
- Worker Scheduler：Cron 触发的探测引擎（可与 API 同一个 Worker 模块）。
- D1：配置、状态、事件与历史数据。
- 外部通知：Webhook（Discord/Slack/Telegram/自定义）。

### 5.2 架构图 (Conceptual)

```mermaid
graph TD
  Visitor[访客] -->|HTTPS| Pages[Cloudflare Pages (UI)]
  Admin[管理员] -->|HTTPS| Pages

  Pages -->|fetch /api| Worker[Cloudflare Worker (API)]
  Worker --> D1[(D1 Database)]

  Cron[Cron Trigger] --> Scheduler[Worker (scheduled: Monitor Engine)]
  Scheduler -->|HTTP fetch / TCP connect| Targets[目标服务]
  Scheduler -->|write results| D1
  Scheduler -->|webhook| Notify[外部通知]
```

---

## 6. 监控引擎设计 (Monitor Engine)

### 6.1 核心概念

- Monitor：一个被监控对象（HTTP URL 或 TCP host:port）。
- Check：一次探测（可能包含多次 retry）。
- State：监控项当前状态（UP/DOWN/MAINTENANCE/PAUSED/UNKNOWN）。
- Outage：一次从 UP -> DOWN -> UP 的故障区间（用于 SLA 与事件自动化）。

### 6.2 HTTP(S) Monitor

支持项（v0.x）：

- Method：GET/HEAD/POST/PUT/DELETE（默认 GET）。
- Timeout：默认 10s（可配）。
- Headers：可配；默认附加 `User-Agent: Uptimer/<version>`。
- Body：可选（主要用于 POST 探测）。
- Status code assertion：
  - 默认：2xx 视为成功（可选包含 3xx）。
  - 可配置允许码列表（如 `[200,204,301]`）。
- Response assertion：
  - `responseKeyword`：必须包含（可选）。
  - `responseForbiddenKeyword`：必须不包含（可选）。

避免缓存污染（重要）：

- 对探测 fetch 显式禁用缓存，避免 Cloudflare 缓存导致“假成功/假失败”：
  - 标准 `fetch` 选项可用 `cache: 'no-store'|'no-cache'`。
  - 也可通过 `cf.cacheTtlByStatus` 强制控制缓存行为（参考 Workers fetch 与 cache 配置示例）。
  - 实现建议：对所有状态码设置不缓存（例如 `cf.cacheTtlByStatus: { '100-599': -1 }`），并在必要时设置随机 query 参数作为兜底。

TLS 相关说明：

- v0.x 以“TLS 可用/可信”作为检查：证书过期或不受信任会导致 fetch 失败，从而判定 DOWN。
- “提前 N 天提醒证书到期”需要获取证书 NotAfter 信息，Workers 原生 fetch 不直接暴露证书链；该能力作为后续增强（见 16）。

### 6.3 TCP Port Monitor

实现方式：

- 使用 Workers TCP Socket API：
  - `import { connect } from 'cloudflare:sockets'`
  - `connect({ hostname, port })` 后等待连接建立并立即关闭
- 以“TCP 握手是否成功 + 耗时”作为可用性与延迟指标。

注意：

- 这不是 ICMP；但对“端口可达性”非常有效。
- 必须做目标校验与速率控制，避免被滥用为端口扫描器（见 12.2）。

### 6.4 “Ping/ICMP”策略

Workers 不提供原生 ICMP；v0.x 定义：

- 统一指标字段：`latency_ms`（UI 文案统一用 “Latency”，不出现 “ICMP Ping”）。
- HTTP Monitor：`latency_ms =` 从发起 `fetch()` 到收到响应头（headers）的耗时（不包含完整读 body；断言 keyword 需要读 body 时会额外消耗时间，需在实现中单独标记）。
- TCP Monitor：`latency_ms =` 从 `connect()` 到 `socket.opened` resolve 的耗时。

### 6.5 重试、抖动与状态机 (Flapping Control)

推荐默认策略（可配置）：

- 单次 Check 失败时进行快速重试 1~2 次（例如间隔 300ms/800ms）。
- 仅当“连续失败达到阈值”才从 UP -> DOWN（例如 2/3）。
- 恢复同理：连续成功达到阈值才从 DOWN -> UP（例如 2）。
- 告警节流：
  - Grace period（例如 DOWN 持续 >= 1 分钟才发第一次告警）
  - Error reason 变化是否通知（可选）

### 6.6 并发控制与超时预算

- 每分钟 Cron 执行时，对 Monitor 列表做并发限制（默认 5），避免超过 Workers 出站连接并发限制。
- 为整轮扫描设置总预算（例如 50s），超出则记录 UNKNOWN 并留到下轮。
- 通过 `AbortController` / 超时包装确保 fetch 与 socket 不悬挂。

### 6.7 多地域探测（v1+ 的扩展点）

v0.x 仅“单探针”（Cron 在某个运行位置执行）。后续可扩展：

- 多探针 Worker / Durable Object 远程探测（为不同 region/colo 采集延迟）。
- 外部探针 API（可选，不作为默认依赖）。

### 6.8 调度器执行流程（scheduled / Cron tick）

Cron 建议配置为每分钟触发一次（`* * * * *`），但并不意味着每分钟对所有 monitor 全量扫描；Uptimer 应基于 `interval_sec` 做“到期探测”。

推荐流程：

1. 对齐当前时间片：`checked_at = floor(now / 60) * 60`（用于去重、图表与窗口计算）。
2. 获取分布式锁（防止 scheduled 重叠）：
   - 以 D1 `locks` 表实现一个带过期时间的 lease（例如 55s），拿不到锁则直接退出。
3. 拉取待探测列表：
   - `monitors.is_active = 1`
   - `monitor_state.status != 'paused'`
   - `monitor_state.last_checked_at IS NULL OR last_checked_at <= now - interval_sec`
4. 并发受控地执行探测：
   - HTTP：禁用缓存 + 超时 +（可选）断言 body keyword
   - TCP：`cloudflare:sockets` connect + 超时
   - 对失败做快速 retry，并结合连续成功/失败阈值更新状态机。
5. 写入 D1（建议用 `DB.batch()` 保证同一 monitor 的状态更新原子性）：
   - 插入 `check_results`（短期序列）
   - Upsert `monitor_state`（当前状态）
   - 维护 `outages`（状态变更时开/关区间）
6. 触发通知：
   - 仅在“状态变更且不处于维护窗口”时发送 `monitor.down`/`monitor.up`。
   - 使用 `notification_deliveries` 的唯一键去重，避免重复告警。
   - 如需缩短单轮执行时间，可用 `ctx.waitUntil()` 异步发送通知。

可选：记录本轮执行位置（colo/region）用于展示“当前探针位置”与排障（例如通过请求 `https://cloudflare.com/cdn-cgi/trace` 解析 `colo=`）。

### 6.9 Free Plan CPU Profile（当前发布基线）

Issue #24 的最终发布基线针对 Cloudflare Free Plan `10ms CPU` 预算做了专项优化：

- scheduled wrapper 只做轻量编排；实际探测拆为 `POST /api/v1/internal/scheduled/check-batch` 子 invocation。
- check-batch 在已持有 scheduler lease 且 chunk 唯一时使用 trusted scheduler lease 模式，避免重复 D1 batch/monitor lock 长尾。
- monitor runtime updates 先收集为 compact updates，再由单个 bulk writer 写入 runtime update fragments。
- public homepage/status 继续走 D1 静态预计算快照；不以 live compute 作为公共 API 主路径。
- homepage/status 快照使用 D1 fragments 分片 seed、raw JSON assemble、continuation publish。
- `homepage:artifact` 的 monitor preload card HTML 在 fragment seed 阶段预渲染，artifact publish 只拼接预渲染 fragments。
- 正常 scheduled summary logs 默认关闭；warnings/errors 保留。

发布验证证据见 `Develop/Worker-CPU-10ms-Release-Readiness.md`。被拒绝的 `UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED` 不属于发布基线。

---

## 7. 数据模型 (D1 Schema Strategy)

目标：

- 配置与当前状态查询要快（后台列表、状态页聚合）。
- 历史数据要“够用且可控”：图表需要短期高精度，SLA 需要长期可计算。

### 7.1 表与职责

说明：SQLite/D1 中 `BOOLEAN` 等价于整数；建议统一用 `INTEGER`(0/1) + CHECK 约束。

```sql
-- 监控项配置
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('http', 'tcp')),
  target TEXT NOT NULL, -- http(s)://... 或 host:port

  interval_sec INTEGER NOT NULL DEFAULT 60 CHECK (interval_sec >= 60),
  timeout_ms   INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms >= 1000),

  -- HTTP-only 配置（JSON 用 TEXT 存储，应用层校验）
  http_method TEXT,
  http_headers_json TEXT,
  http_body TEXT,
  expected_status_json TEXT, -- e.g. [200,204,301]
  response_keyword TEXT,
  response_forbidden_keyword TEXT,

  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- 监控项当前状态（用于快速读取；由调度器更新）
CREATE TABLE IF NOT EXISTS monitor_state (
  monitor_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('up','down','maintenance','paused','unknown')),
  last_checked_at INTEGER,
  last_changed_at INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0
);

-- 短期探测记录（用于心跳条/延迟图），建议保留 24h~7d，按项目规模调优
CREATE TABLE IF NOT EXISTS check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  checked_at INTEGER NOT NULL, -- unix seconds
  status TEXT NOT NULL CHECK (status IN ('up','down','maintenance','unknown')),
  latency_ms INTEGER,
  http_status INTEGER,
  error TEXT,
  location TEXT, -- 可选：colo/region
  attempt INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_check_results_monitor_time
  ON check_results(monitor_id, checked_at);

-- 故障区间（长期保留，用于 SLA 与历史事件）
CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER, -- NULL 表示仍在故障中
  initial_error TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outages_monitor_start
  ON outages(monitor_id, started_at);

-- 公共事件（可手工创建，也可选择自动从 outages 生成）
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
  impact TEXT NOT NULL DEFAULT 'minor' CHECK (impact IN ('none','minor','major','critical')),
  message TEXT, -- 首条说明
  started_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  status TEXT CHECK (status IN ('investigating','identified','monitoring','resolved')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident_time
  ON incident_updates(incident_id, created_at);

-- Incident 与 monitors 关联（多对多；用于状态页展示影响范围）
CREATE TABLE IF NOT EXISTS incident_monitors (
  incident_id INTEGER NOT NULL,
  monitor_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  PRIMARY KEY (incident_id, monitor_id)
);
CREATE INDEX IF NOT EXISTS idx_incident_monitors_monitor
  ON incident_monitors(monitor_id);

-- 维护窗口（维护期间不触发 DOWN 告警，可在状态页展示）
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- 维护窗口与 monitors 关联（多对多；用于“告警抑制”与状态页展示）
CREATE TABLE IF NOT EXISTS maintenance_window_monitors (
  maintenance_window_id INTEGER NOT NULL,
  monitor_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  PRIMARY KEY (maintenance_window_id, monitor_id)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_window_monitors_monitor
  ON maintenance_window_monitors(monitor_id);

-- 通知渠道（先做 Webhook；后续可扩展 provider 字段）
CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook')),
  config_json TEXT NOT NULL, -- { url, method, headers, payloadTemplate, timeoutMs, ... }
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- 通知发送记录（用于去重/审计/重放排查）
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL, -- e.g. monitor:12:down:1700000000
  channel_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failed')),
  http_status INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_event_channel
  ON notification_deliveries(event_key, channel_id);

-- 轻量设置/密钥引用（敏感值优先用 Workers Secrets；DB 仅存非敏感配置）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 分布式锁（防止 scheduled 重叠执行）
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- 公共 API 静态快照（homepage/status/homepage:artifact fast path）
CREATE TABLE IF NOT EXISTS public_snapshots (
  key TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- 公共快照 guard state/version（跨 Worker isolate 证明 fast guard 状态仍当前）
CREATE TABLE IF NOT EXISTS public_snapshot_guard_versions (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_json TEXT
);

-- 公共快照 fragments（D1-first 分片 seed/assemble/publish）
CREATE TABLE IF NOT EXISTS public_snapshot_fragments (
  snapshot_key TEXT NOT NULL,
  fragment_key TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (snapshot_key, fragment_key)
);
CREATE INDEX IF NOT EXISTS idx_public_snapshot_fragments_snapshot_generated
  ON public_snapshot_fragments(snapshot_key, generated_at);
```

### 7.2 数据保留与清理 (Retention)

默认建议（可配置）：

- `check_results`：保留最近 7 天（或更短，如 24h），用于图表与心跳条。
- `outages` / `incidents`：保留 90 天或更久（体积小）。
- 每日 Cron 执行清理任务：删除过期 `check_results`；可选对 `outages` 做归档。

### 7.3 查询模式与 SLA/图表计算

Heartbeat Bar（最近 N 次探测）：

- 查询：按 `checked_at DESC` 取最近 N 条 `check_results`（例如 60）。
- 展示：UP=绿，DOWN=红，MAINTENANCE=蓝，UNKNOWN=灰。

Latency Chart（时间序列）：

- 查询：按时间窗口拉取 `check_results.latency_ms`（只取 status=up 或单独标记 down）。
- P95：SQLite/D1 没有内置 percentile 聚合，v0.x 在 Worker 中对窗口内数据排序计算（窗口建议 <= 7d）。

Uptime / SLA（按时间窗口计算可用性）：

- 长期窗口优先基于 `outages` 求 downtime（比全量心跳更省存储）：
  - 对每条 outage 计算与窗口 `[rangeStart, rangeEnd)` 的交集秒数并求和。
  - `uptime = 1 - downtime / (rangeEnd - rangeStart)`
- UNKNOWN 的处理需要明确语义（建议 v0.x 默认“UNKNOWN 计为不可用/降级”，并在 UI 上单独展示 Unknown 比例）。

---

## 8. API 设计 (REST API)

### 8.1 约定

- Base path：`/api/v1`
- Content-Type：`application/json; charset=utf-8`
- 时间：统一使用 unix seconds（整数）。
- 错误格式（统一）：

```json
{ "error": { "code": "INVALID_ARGUMENT", "message": "..." } }
```

### 8.2 鉴权与分区

- Public API：状态页读取，无需鉴权（但可加缓存）。
- Admin API：固定使用 `Authorization: Bearer <ADMIN_TOKEN>`（token 存于 Workers Secret）。
- 生产环境建议在 Cloudflare 层额外加一层 Access（SSO）保护 `/admin` 与 `/api/v1/admin/*`，作为“外部防护”，不改变应用内鉴权逻辑。

### 8.3 端点草案

Public:

- `GET /api/v1/public/homepage`：公共首页 JSON；优先读取 `public_snapshots.homepage` / fragments 发布结果。
- `GET /api/v1/public/homepage-artifact`：Pages HTML preload artifact；返回 `preload_html` + `snapshot`。
- `GET /api/v1/public/status`：返回全局状态、组件列表、未解决事件摘要、维护窗口、最近心跳与延迟（状态页首屏）。
- `GET /api/v1/public/monitors/:id/latency?range=24h`：延迟序列（对外可限制粒度）。
- `GET /api/v1/public/monitors/:id/uptime?range=24h|7d|30d`：SLA/可用性统计（含 downtime 秒数与 Unknown 比例）。
- `GET /api/v1/public/incidents?limit=20`：历史事件列表。
- `GET /api/v1/public/maintenance-windows?limit=20`：公开维护窗口列表。

Admin:

- `GET /api/v1/admin/monitors`
- `POST /api/v1/admin/monitors`
- `PATCH /api/v1/admin/monitors/:id`
- `DELETE /api/v1/admin/monitors/:id`
- `POST /api/v1/admin/monitors/:id/test`：立即探测一次（不写入或写入标记为 manual）。

- `GET /api/v1/admin/incidents`
- `POST /api/v1/admin/incidents`
- `POST /api/v1/admin/incidents/:id/updates`
- `PATCH /api/v1/admin/incidents/:id/resolve`
- `DELETE /api/v1/admin/incidents/:id`

- `GET /api/v1/admin/maintenance-windows`
- `POST /api/v1/admin/maintenance-windows`
- `PATCH /api/v1/admin/maintenance-windows/:id`
- `DELETE /api/v1/admin/maintenance-windows/:id`

- `GET /api/v1/admin/notification-channels`
- `POST /api/v1/admin/notification-channels`
- `PATCH /api/v1/admin/notification-channels/:id`
- `DELETE /api/v1/admin/notification-channels/:id`
- `POST /api/v1/admin/notification-channels/:id/test`

Internal（Bearer Token + feature flags；scheduled/service-binding 使用，不作为公共产品 API）：

- `POST /api/v1/internal/scheduled/check-batch`
- `POST /api/v1/internal/write/runtime-update-fragments`
- `POST /api/v1/internal/refresh/runtime-fragments`
- `POST /api/v1/internal/seed/sharded-public-snapshot`
- `POST /api/v1/internal/assemble/sharded-public-snapshot`
- `POST /api/v1/internal/continue/sharded-public-snapshot`

### 8.4 分页与过滤

- 列表接口默认 `limit=50`，最大 200；使用 `cursor`（基于 id 或时间）做游标分页，避免 offset 在大表上的性能问题。

---

## 9. 通知系统 (Notification Dispatcher)

### 9.1 事件类型

- `monitor.down`：UP -> DOWN（或 UNKNOWN -> DOWN）
- `monitor.up`：DOWN -> UP
- `incident.created` / `incident.updated` / `incident.resolved`
- `maintenance.started` / `maintenance.ended`（可选）

### 9.2 Webhook 标准 Payload（建议）

```json
{
  "event": "monitor.down",
  "event_id": "monitor:12:down:1700000000",
  "timestamp": 1700000000,
  "monitor": {
    "id": 12,
    "name": "API",
    "type": "http",
    "target": "https://api.example.com/health"
  },
  "state": {
    "status": "down",
    "latency_ms": 10000,
    "http_status": 0,
    "error": "Timeout after 10000ms",
    "location": "HKG"
  },
  "links": {
    "status_page": "https://status.example.com",
    "admin": "https://status.example.com/admin"
  }
}
```

Webhook Channel `config_json`（建议字段）：

```json
{
  "url": "https://example.com/webhook",
  "method": "POST",
  "headers": { "Authorization": "Bearer xxx" },
  "timeout_ms": 5000,
  "payload_type": "json",
  "signing": {
    "enabled": false,
    "secret_ref": "UPTIMER_WEBHOOK_SIGNING_SECRET"
  }
}
```

签名（可选）：

- 若启用 signing，发送时附加：
  - `X-Uptimer-Timestamp: <unix seconds>`
  - `X-Uptimer-Signature: sha256=<hmac>`（对 `timestamp + "." + rawBody` 做 HMAC-SHA256）
- 目的：让接收方可验证来源与防重放（接收方校验 timestamp 在允许窗口内）。

### 9.3 去重与重试

- `event_id`/`event_key` 用于幂等：同一事件对同一 channel 只发送一次（用 `notification_deliveries` UNIQUE 约束）。
- 失败重试：v0.x 可做“有限次重试 + 指数退避”（例如 3 次：0s/10s/60s）；更可靠方案是引入 Cloudflare Queues（后续）。

---

## 10. 事件管理 (Incident Management)

### 10.1 事件类型与生命周期

- 类型：`Issue`（故障）、`Maintenance`（维护）
- 状态：Investigating -> Identified -> Monitoring -> Resolved

### 10.2 与监控项的关系

- v0.x 可先不做复杂关联：事件中用文本描述影响范围。
- v0.2+ 建议支持 incident 与 monitors 的关联（多对多）：创建事件时指定 `monitor_ids`，状态页按受影响组件展示。
- v1 可进一步扩展到 components（多对多），并支持更复杂的分组/聚合展示。

---

## 11. UI/UX 原则

公共状态页（对齐 Statuspage 体验）：

- 全局状态 Banner（All Operational / Partial Outage / Major Outage / Maintenance）。
- 组件/服务列表：显示当前状态 + 最近心跳条 + 最近延迟趋势迷你图。
- 未解决事件置顶；历史事件分页。

状态聚合规则（v0.x 建议，后续可配置）：

- 单个 monitor：`monitor_state.status` 直接决定展示色块（up/down/maintenance/unknown/paused）。
- 全局 Banner：
  - 若存在未解决的手工事件（`incidents.status != resolved`），优先按其 `impact` 映射为 Partial/Major（并展示事件摘要）。
  - 否则按 monitors 聚合：存在任意 DOWN => Partial；DOWN 比例超过阈值（例如 30%）=> Major；无 DOWN 但存在 MAINTENANCE => Maintenance；其余 => All Operational。

管理后台（对齐 Uptime Kuma 易用性）：

- 监控项列表：状态、最近一次探测、错误原因、延迟。
- 监控项配置向导：HTTP/TCP 两种模板。
- 事件编辑器：支持 Markdown（渲染到状态页）。
- 通知渠道测试：一键发送 test webhook。

---

## 12. 安全 (Security)

### 12.1 管理端鉴权

- 应用内鉴权：Bearer Token（存储在 Workers Secret；不要写入 Git 与 D1）。
- 生产环境外部防护：Cloudflare Access（可选，建议开启）。

### 12.2 输入校验与 SSRF/滥用防护

监控项配置会触发出站请求，应视为“受控 SSRF 能力”，需要：

- 限制协议：HTTP(S) 或 TCP；拒绝 file://、ftp:// 等。
- 端口：不再限制（允许 1-65535）。注意：这会提升被滥用为端口扫描器的风险，生产环境务必配合外部防护（如 Cloudflare Access）与速率限制。
- 可选拒绝私网/保留地址段（10.0.0.0/8、192.168.0.0/16、127.0.0.0/8、::1 等），避免内部扫描与误用。
- 后台 API 做速率限制（优先用 Cloudflare WAF/Rate Limiting 规则）。

### 12.3 审计

- v0.x：至少记录关键操作日志（monitor/incident/notification 配置变更）到 Workers logs；
- v1：落表 `audit_logs`（可选）。

---

## 13. 开发与部署 (DevOps)

### 13.1 本地开发

- 后端：`wrangler dev`（启用 D1 本地/预览库），调试 `fetch` 与 `scheduled`。
- 前端：Vite dev server；通过代理转发 `/api` 到 wrangler 端口。

### 13.2 部署 (CI/CD)

建议 GitHub Actions：

- 前端：build -> deploy to Cloudflare Pages
- 后端：`wrangler deploy`
- 数据库：`wrangler d1 migrations apply <db> --remote`

### 13.3 wrangler 配置要点（示例）

```toml
name = "uptimer"
main = "src/index.ts"
compatibility_date = "2026-01-28"
minify = true

[triggers]
crons = ["* * * * *", "0 0 * * *", "30 0 * * *"]

[[d1_databases]]
binding = "DB"
database_name = "uptimer"
database_id = "<uuid>"

[vars]
ADMIN_RATE_LIMIT_MAX = "60"
ADMIN_RATE_LIMIT_WINDOW_SEC = "60"
UPTIMER_SCHEDULED_STATUS_REFRESH = "1"
UPTIMER_TRUST_SCHEDULED_RUNTIME_UPDATES = "1"
UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = "2"
# Free Plan CPU profile: see Develop/Worker-CPU-10ms-Release-Readiness.md
UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES = "1"
UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH = "1"
UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED = "1"
UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED = "1"
UPTIMER_PUBLIC_SHARDED_ASSEMBLER = "1"
UPTIMER_SCHEDULED_SHARDED_ASSEMBLER = "1"
UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH = "1"
UPTIMER_SCHEDULED_SHARDED_PUBLISH = "1"
UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES = "1"
UPTIMER_SHARDED_ASSEMBLER_MODE = "json"
UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH = "1"
UPTIMER_SCHEDULED_SHARDED_CONTINUATION = "1"
UPTIMER_SHARDED_FRAGMENT_SEED_BATCH_SIZE = "4"
UPTIMER_SHARDED_RUNTIME_UPDATE_BATCH_SIZE = "5"
UPTIMER_INTERNAL_SCHEDULED_CHECK_BATCH_TIMEOUT_MS = "75000"
UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT = "1"
UPTIMER_INTERNAL_CHECK_BATCH_TRUST_SCHEDULER_LEASE = "1"
UPTIMER_SCHEDULED_REFRESH_LOGS = "0"
```

`UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED` 曾实测产生 continuation CPU outliers，不属于发布基线。

---

## 14. 可观测性 (Observability)

- Scheduler 每轮输出结构化日志：轮次 id、处理 monitor 数、成功/失败、耗时、触发 colo。
- 对关键异常（D1 写失败、通知失败、探测异常）输出 error logs。
- v1 可接入 Workers Analytics Engine 做轻量指标（可选）。

---

## 15. 里程碑 (Roadmap)

v0.1（MVP）：

- HTTP/TCP 探测 + 重试/超时 + 状态机
- D1：monitors / monitor_state / check_results / outages
- Webhook 通知（down/up）
- 公共状态页 + 管理后台基础 CRUD

v0.2：

- 事件管理（incidents + timeline）与状态页展示
- 维护窗口（maintenance）与告警抑制
- 数据保留任务（每日清理）

v0.3+（可选增强）：

- 多地域探测（多探针/DO locationHint/外部探针）
- 证书到期提前告警（需要额外实现途径）
- 通知渠道扩展（Slack/Telegram 等内置模板）
- 更完善的审计、导出、备份与恢复策略

---

## 16. 参考资料 (References)

- Workers Cron Triggers / `scheduled()`：https://developers.cloudflare.com/workers/configuration/cron-triggers/
- D1 prepared statements / bind/run：https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- D1 查询最佳实践：https://developers.cloudflare.com/d1/best-practices/query-d1/
- Workers TCP sockets (`cloudflare:sockets`)：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- Workers fetch 与 cache 配置示例：https://developers.cloudflare.com/workers/examples/cache-using-fetch/
- Hono (Workers web framework)：https://hono.dev/
- Drizzle ORM：https://orm.drizzle.team/
- React：https://react.dev/
- Vite：https://vitejs.dev/
- React Router：https://reactrouter.com/
- TanStack Query：https://tanstack.com/query/latest
- Tailwind CSS：https://tailwindcss.com/
