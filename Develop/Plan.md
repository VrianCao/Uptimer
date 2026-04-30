# Plan.md: Delivery Plan (Uptimer v0.1+)

Phased delivery plan from MVP to production. Each phase includes acceptance criteria.

> Phases 0–12 are **complete**. Issue #24 Free Plan CPU timeout closeout is released via PR #77/#78 and documented in `Worker-CPU-10ms-Release-Readiness.md`. See REVIEW.md for remaining gaps.

---

## Post-release baseline — Issue #24 CPU closeout（2026-04-29）

状态：已发布到 Main，并已同步 Dev。

验收证据：

- Final controlled Dev Tail：`BAD_OR_GE10 count=0`，所有采样 invocation path 严格 `<10ms`。
- Production post-release Tail：`BAD_OR_GE10 count=0`。
- Public parity：`/api/v1/public/homepage`、`/api/v1/public/status`、`/api/v1/public/homepage-artifact` 均返回 `200`。

发布基线：

- Free Plan CPU profile 已写入 `apps/worker/wrangler.toml`。
- Homepage/status 继续使用静态预计算快照；不以 live compute 作为公共 API 主路径。
- `UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED` 已实测拒绝，不属于发布基线。

---

## 0. Constraints (Locked)

- 平台：Cloudflare Workers + Pages + D1
- 前端：React + Vite + TypeScript + Tailwind + React Router + TanStack Query + Recharts
- 后端：TypeScript + Hono + Zod
- DB：D1 + Drizzle ORM；迁移用 Wrangler D1 migrations
- 鉴权：Admin Bearer Token（Workers Secret）

---

## 1. Phase 0 — 仓库初始化（1 天）

任务：

- 建立 monorepo 目录结构：`apps/web`、`apps/worker`、`packages/shared`、`packages/db`
- 统一包管理器与 Node 版本：
  - `pnpm` + `pnpm-workspace.yaml`
  - `.nvmrc` / `.node-version`（固定 Node 版本）
- 基础工程化：
  - TypeScript base config（strict）
  - ESLint + Prettier（前后端一致）
  - GitHub Actions：lint + typecheck（先不部署也可）

验收（DoD）：

- `pnpm -r lint`、`pnpm -r typecheck` 可运行（即使只有空项目）

---

## 2. Phase 1 — D1 Schema & Migrations（1 天）

任务：

- 根据 `Application.md` 建立首个 migration：
  - `monitors`、`monitor_state`、`check_results`、`outages`
  - `incidents`、`incident_updates`
  - `maintenance_windows`
  - `notification_channels`、`notification_deliveries`
  - `settings`、`locks`
- 添加必要索引（按 `monitor_id, checked_at` 等）
- `packages/db`：
  - Drizzle schema 定义与 D1 client 封装
  - 为 `*_json` 字段提供 Zod 校验与序列化工具

验收（DoD）：

- `wrangler d1 migrations apply` 可对本地/远程库执行（至少本地可跑通）
- Worker 能连接 D1 并执行一次简单查询（healthcheck）

---

## 3. Phase 2 — Worker API 骨架（1–2 天）

任务：

- Hono 路由分层：
  - `/api/v1/public/*`（无需鉴权）
  - `/api/v1/admin/*`（Bearer Token 中间件）
- 统一错误响应格式与输入校验（Zod）
- 实现最小 API：
  - `GET /api/v1/public/status`（先返回占位数据）
  - `GET /api/v1/admin/monitors` / `POST /api/v1/admin/monitors`

验收（DoD）：

- 本地 `wrangler dev` 下可访问 API，鉴权正确生效
- Monitor CRUD 能写入 D1，并能读回

---

## 4. Phase 3 — 监控引擎（scheduled）（2–4 天）

任务：

- `scheduled()` 实现（每分钟 tick）：
  - D1 lease 锁（`locks` 表）防重叠执行
  - 计算“到期 monitors”（基于 `interval_sec` 与 `last_checked_at`）
  - 并发限制（p-limit 默认 5）
- HTTP check：
  - 超时（AbortController）
  - 禁用缓存（`cache: 'no-store'` + `cf.cacheTtlByStatus: { '100-599': -1 }`）
  - 状态码断言、关键字断言（必要时读取 body）
- TCP check：
  - `cloudflare:sockets` connect + 超时 + close
- 状态机：
  - 连续失败/成功阈值（UP->DOWN、DOWN->UP）
  - 写入 `check_results`、upsert `monitor_state`
  - 维护 `outages`（开/关区间）

验收（DoD）：

- 至少 2 个 monitor（HTTP + TCP）可稳定跑通
- `monitor_state` 会随探测更新；DOWN/UP 切换正确；`outages` 区间正确闭合

---

## 5. Phase 4 — 通知（Webhook）（1–2 天）

任务：

- `notification_channels` CRUD（admin）
- Webhook dispatch：
  - 支持 method/headers/timeout/payloadType(json)
  - 幂等：`notification_deliveries` 唯一键去重
  - 可选签名（HMAC-SHA256）
- 通知触发：
  - 仅在状态变更且不处于维护窗口时发送 `monitor.down`/`monitor.up`
  - 使用 `ctx.waitUntil()` 发送，避免阻塞 scheduled 主流程

验收（DoD）：

- DOWN/UP 状态变更可触发 webhook
- 重复触发不会重复发送（幂等生效）

---

## 6. Phase 5 — Public API 数据化（1–2 天）

任务：

- `GET /api/v1/public/status`：
  - 从 `monitor_state` 聚合全局状态
  - 返回 monitors 列表 + 最近心跳（每个 monitor 最近 N 条）
- `GET /api/v1/public/monitors/:id/latency?range=24h`
- `GET /api/v1/public/monitors/:id/uptime?range=24h|7d|30d`：
  - 基于 `outages` 计算 downtime 与 uptime%
  - UNKNOWN 语义按 `Application.md` 执行

验收（DoD）：

- 状态页可仅靠 Public API 完成首屏渲染

---

## 7. Phase 6 — Web（状态页 + 管理后台 MVP）（2–5 天）

任务：

- Web 基础：
  - React Router 路由：Status / Admin
  - TanStack Query 接入 Public/Admin API
  - Tailwind 基础布局与主题
- 状态页：
  - 全局 banner + monitors 列表
  - Heartbeat bar（最近 60 次）
  - Latency chart（24h）
- 管理后台：
  - monitors CRUD
  - 手动 test check（`POST /admin/monitors/:id/test`）
  - notification channels CRUD + test

验收（DoD）：

- 通过 UI 可完成：新增 monitor -> scheduled 自动探测 -> 状态页展示 -> DOWN 触发通知

---

## 8. Phase 7 — Retention / Hardening / Release（1–3 天）

任务：

- Retention：
  - 每日清理 `check_results` 过期数据（可配置保留天数）
- 安全与滥用防护：
  - monitor target 校验（协议/端口/私网限制）
  - admin API 速率限制（Cloudflare 侧规则 + 应用内基础限制）
- 可观测性：
  - scheduled 每轮结构化日志（数量、耗时、失败原因分布）
- 发布准备：
  - 文档：README（快速部署、环境变量、迁移步骤）

验收（DoD）：

- MVP 可部署到 Cloudflare：Pages + Worker + D1 migrations 一次性跑通
- 数据不会无限膨胀（Retention 生效）

---

## 9. Phase 8 — Incidents（事件系统）& Status Page 集成（v0.2）（2–4 天）

任务：

- Worker API（admin）：
  - 完整实现 incidents：`GET/POST /api/v1/admin/incidents`
  - incident updates：`POST /api/v1/admin/incidents/:id/updates`
  - resolve：`PATCH /api/v1/admin/incidents/:id/resolve`
  - delete：`DELETE /api/v1/admin/incidents/:id`
  - 事件与监控项关联：创建事件时指定 `monitor_ids: number[]`（影响范围）
  - 输入校验（Zod）与错误格式统一（按 `Application.md`）
- Worker API（public）：
  - `GET /api/v1/public/incidents?limit=20`（含未解决置顶、分页/limit）
  - `GET /api/v1/public/status` 聚合未解决事件摘要（banner 展示）
  - Public 输出包含事件的 `monitor_ids`，用于状态页展示“受影响组件”
- 通知扩展：
  - 触发 `incident.created / incident.updated / incident.resolved`
  - 复用 `notification_deliveries` 幂等键（避免同一 update 重复发送）
- Web UI：
  - 后台新增事件管理页：创建/更新/解决（Markdown 编辑 + 预览）
  - 状态页新增事件列表与事件详情（timeline），未解决置顶
  - 事件在 UI 上显示“受影响 monitors”（与 monitor 列表联动）

验收（DoD）：

- 后台可创建事件并追加 updates；状态页能看到对应 timeline
- 事件状态变化可触发 webhook（幂等生效、失败可追踪）

---

## 10. Phase 9 — Maintenance Windows（维护窗口）& 告警抑制（v0.2）（2–4 天）

任务：

- Worker API（admin）：
  - `maintenance_windows` CRUD（至少 list/create/delete；可选 update）
  - 时间输入统一 unix seconds；校验 `starts_at < ends_at`
  - 维护窗口与监控项关联：创建/更新时指定 `monitor_ids: number[]`
- Scheduler 语义落地（按 `Application.md`）：
  - 在维护窗口内：仅对被关联的 monitors 抑制 down/up 通知（告警抑制）
  - 状态页展示维护（active/upcoming 列表，并显示受影响 monitors）
  - 可选：维护开始/结束触发 `maintenance.started / maintenance.ended`
- Web UI：
  - 后台维护窗口管理（创建表单 + 列表）
  - 状态页展示 active/upcoming maintenance（与 incidents 同风格）

验收（DoD）：

- 维护窗口期间：仅关联 monitors 的 DOWN/UP 不会触发通知；其它 monitors 正常告警
- 状态页能正确展示 active/upcoming 维护信息

---

## 11. Phase 10 — Analytics & 报表（v0.3）（3–7 天）

任务：

- 指标与查询（保持 D1 可控，按 `Application.md` 7.3）：
  - 监控详情：P50/P95 latency、uptime%、downtime 秒数、Unknown 比例（range=24h/7d/30d/90d）
  - 全局概览：最近 24h/7d 的整体 uptime、告警次数、最长 outage、MTTR（可先基于 outages/incident 近似）
  - 大窗口性能优化：必要时新增“日级 rollup 表”（migration），并由每日 Cron 回填
- Worker API：
  - Public：为状态页提供 30d/90d 的 uptime 概览（避免前端做重计算）
  - Admin：新增 analytics endpoints（命名保持 `/api/v1/admin/*`，并做分页/limit）
- Web UI：
  - 后台新增 Analytics 页面（全局概览 + monitor 详情图表，Recharts）
  - 图表交互：range selector、tooltip、空数据态、加载态
- 导出（可选）：
  - CSV 导出：outages/incidents/check_results（受 retention 限制）

验收（DoD）：

- 7d/30d 查询在可接受时间内完成（避免一次性拉全量导致超时）
- 后台能查看至少：uptime%、P95 latency、outage 列表（并可按时间过滤）

---

## 12. Phase 11 — UI/UX 完善（Dashboard + Status Page）（2–6 天）

任务：

- 后台体验：
  - Monitor 创建向导：HTTP/TCP 模板、实时校验（端口/协议/私网限制提示）、测试探测按钮
  - 列表增强：搜索/过滤（按 type/status）、排序、分页、批量操作（可选）
  - 全局反馈：Toast、表单错误聚合、loading skeleton、空状态文案
- 状态页体验：
  - Banner 规则严格按 `Application.md`（incident 优先）
  - 更明确的状态解释：Unknown/Paused/Maintenance 文案与图例
  - 移动端适配、基础无障碍（键盘可达、对比度）
- 工程一致性：
  - 前端 API error 映射（统一展示 `error.code/message`）
  - 组件抽象（表格/弹窗/表单控件）避免重复

验收（DoD）：

- 不依赖“懂内部实现”的情况下，用户可完成：创建 monitor -> 测试 -> 保存 -> 看图表/事件
- 基础交互（loading/empty/error）覆盖主要页面

---

## 13. Phase 12 — Settings / 自定义（Branding & 行为参数）（v0.3+）（2–5 天）

任务：

- Settings 规范化：
  - 用 `settings` 表存非敏感配置：站点标题/描述、时区、默认 range、保留天数、阈值默认值（连续失败/成功等）
  - 管理端 settings API：`GET/PATCH /api/v1/admin/settings`（Zod 校验）
- 状态页可定制：
  - Logo/Favicon（Pages 静态资源）与主题色（Tailwind tokens）
  - 可选：自定义公告（类似 Statuspage 的 notice）
- 文档与上线：
  - 增补 README：Pages 自定义域名/HTTPS、Worker 环境变量、迁移步骤

验收（DoD）：

- 不改代码即可调整“站点标题/描述/保留策略/默认阈值”等配置，并在 UI 生效

---

## 14. Phase 13 — 审计 / 运营工具（v0.3+）（2–5 天）

任务：

- 审计日志（按 `Application.md` 12.3）：
  - v0：关键操作结构化日志完善（monitor/incident/notification/settings）
  - v1（可选）：新增 `audit_logs` 表（migration）并落库，提供查询 API 与 UI
- 数据工具：
  - 配置导入/导出（JSON）：monitors、notification_channels、settings（不包含 secrets）
  - 故障复盘辅助：一键导出某 monitor 在时间窗口内的 outages/incidents/check_results

验收（DoD）：

- 能回答“谁在什么时候改了什么配置”（至少 logs；可选落库）
- 能导出一份可复现问题的最小数据包（用于 issue/分享）

---

## 15. Phase 14 — Advanced Monitoring & 通知规则（v1）（3–10 天）

任务：

- 监控能力增强（不引入新服务）：
  - HTTP：响应时间阈值告警、header 断言、允许/禁止重定向（可配）
  - Flapping 控制：cooldown、grace period、error reason 变更策略（按 `Application.md` 6.5）
- 通知规则：
  - 细化触发条件：按 monitor/tag/impact 分级通知（可能需要新增 join 表 migration）
  - 预置模板：Discord/Slack/Telegram 等（本质仍为 Webhook 配置模板）
- 状态页细化：
  - 组件分组（Group/Tag）与聚合展示（需要 schema 扩展时以 migration 落地）

验收（DoD）：

- 可通过 UI 配置：某些 monitor 只在“持续 DOWN >= N 分钟”才告警，并可验证生效
- 状态页能按组件分组展示并保持 banner 聚合规则一致

---

## 16. Phase 15 — 多地域探测（可选增强）（v1+）（5–14 天）

说明：Cron 不保证在所有边缘节点触发；若要“多地域探测”，需引入额外机制（见 `Application.md` 6.7）。本阶段属于可选增强，若要引入 Durable Objects/外部探针，需要在变更说明中写清必要性与替代方案。

任务（两种路线二选一）：

- 路线 A：Durable Objects 探针编排（可控 region）
  - 为不同 region 配置 DO `locationHint`，由主调度器 fan-out 请求各 DO 执行 check
  - 数据模型扩展：`check_results.location` 标准化（region/colo），UI 展示多条曲线/分区状态
- 路线 B：外部探针（非默认依赖）
  - 定义探针上报协议与签名；Worker 接收并写入结果（仍走现有状态机/通知）

验收（DoD）：

- 同一 monitor 可看到多地域延迟/成功率，并能配置“按多数派/最差地域”决定全局状态（策略可先固定后可配）

---

## 17. Phase 16 — “产品化”收尾（v1+）（2–6 天）

任务：

- 性能与成本：
  - Public API 缓存（`caches.default` + TTL），并保证监控探测请求仍为 no-store
  - scheduled 执行时间与 D1 查询优化（索引审计、批量写、降级策略）
- 发布体验：
  - 完整的部署向导文档（从 0 到上线）
  - 示例数据/演示模式（可选，便于自测 UI）
- 稳定性与回归：
  - 补齐关键单测/集成测试（状态机、SLA 计算、incident/maintenance 聚合）
  - 回归用例清单（手动步骤 + curl）

验收（DoD）：

- 新用户按文档可在 30 分钟内完成部署并看到第一条监控数据
- 有一套可重复执行的回归步骤，覆盖核心路径（探测->状态机->通知->状态页）
