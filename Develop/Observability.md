# Observability.md：Uptimer 可观测性与安全使用（Workers CPU 优化用）

本项目在 Cloudflare 平台上做性能优化时，**唯一**可信的最终指标是线上 Cloudflare Workers Metrics 里的 **CPU Time（尤其 P50/P90）**。但 Metrics 颗粒度很粗，因此需要一套“能定位到链路/函数段”的最小可观测性组合，既能调试，又不会把“可观测性本身”变成性能税。

本文总结当前仓库内已落地的可观测性能力与使用方法（不涉及新的架构方案）。

---

## 0. 安全边界

本文只记录 header 名、环境变量名、命令模板与排查流程，**不能**记录任何真实 token、secret、Cloudflare account id、database id、管理员口令或私有域名。

生产环境与任何公网可访问环境必须为 Trace 配置 token gate：

- 首选 `UPTIMER_TRACE_TOKEN`
- 兼容备用 `TRACE_TOKEN`

没有 token gate 的匿名 Trace 只能用于本地或受访问控制保护的临时环境。`X-Uptimer-Trace-Mode: bypass-cache` 会改变缓存路径，只能用于诊断，不能作为普通用户路径或发布性能结论的唯一依据。

输出处理规则：

- 不要把 `X-Uptimer-Trace-Token` 写进公开文档、Issue、PR、聊天记录或测试 fixture。
- `wrangler tail` 与 Trace 响应可能包含请求 URL、query、header、错误信息和内部路径标签；分享前必须脱敏。
- 需要保存原始 tail/trace 输出时，放入 gitignored 的 `tmp/` 或其他本地临时目录，不要提交。
- 示例命令只能使用占位符，例如 `<your-worker-origin>`、`<your-pages-origin>`、`<token>`。

---

## 1. 信号层级（按可信度/成本排序）

### 1.1 Cloudflare Workers Metrics（最终裁判）

- 指标：CPU time 的 P50/P90/P99 等分位
- 特点：真实线上、覆盖所有请求；但**无法按 route/函数**拆分
- 结论：任何本地 bench / 代码推理 / “看起来更快”，都必须让位于 Metrics

### 1.2 `wrangler tail`（按“单次 invocation”观测 CPU）

用途：当 Metrics 告诉你“变慢了”，`wrangler tail` 可以告诉你**是哪些请求**在烧 CPU，并且能看到每次 invocation 的 `cpuTime`。

前置条件：

- 需要能访问对应 Cloudflare 账号的 Workers Tail（本地一般用 `wrangler login`；在 CI/无浏览器环境用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）
- Worker 名称以 `apps/worker/wrangler.toml` 的 `name` 为准（本仓库默认是 `uptimer`；Dev/多环境可能不同）
- 若 tail 输出用于 issue/PR/release 证据，只记录聚合结果、采样参数与结论；不要贴原始 JSON。

常用命令（按需调 sampling）：

```bash
pnpm --filter @uptimer/worker exec wrangler tail uptimer --format json --sampling-rate 0.2
```

过滤（减少噪声）：

```bash
# 只看 POST
pnpm --filter @uptimer/worker exec wrangler tail uptimer --format json --sampling-rate 0.8 --method POST

# 只看 GET
pnpm --filter @uptimer/worker exec wrangler tail uptimer --format json --sampling-rate 0.5 --method GET

# 只看 ok/error/canceled（canceled 常见于 waitUntil / 内部自调用链路）
pnpm --filter @uptimer/worker exec wrangler tail uptimer --format json --sampling-rate 0.8 --status ok --status error --status canceled
```

解读要点：

- `cpuTime`：本次 invocation 的 CPU（ms）
- `event.request.url`：请求 URL（可定位到 `/api/v1/public/*`、`/api/v1/internal/*` 等）
- `outcome=canceled`：并不一定代表错误；在 `ctx.waitUntil()`、内部自调用等链路中较常见，但 **CPU 依然真实计入**（重点看 `cpuTime` 分布）
- sample rate 会影响证据强度；发布证明优先使用完整采样或明确说明采样率与样本数。

### 1.3 端到端 Trace（Server-Timing + 轻量标签）

用途：当你知道“是某条链路”在烧 CPU，但不知道到底是**读 snapshot / D1 查询 / JSON 处理 / fallback 协调**哪段慢时，开启 Trace 能把一次请求拆成多个 span。

目标：**默认关闭**、按需开启、必须可用 token 保护，避免用户流量被动开启导致性能税或信息泄露。

---

## 2. 当前已实现的 Trace 协议

### 2.1 Header 协议（请求端）

所有 trace 都基于这组 header（Workers 与 Pages Worker 一致；`single_worker` 模式仅有 Worker 层）：

- `X-Uptimer-Trace: 1|true|yes|on`：开启 trace（默认关闭）
- `X-Uptimer-Trace-Id: <id>`：可选；用于跨层关联（不传会自动生成 UUID）
- `X-Uptimer-Trace-Token: <token>`：可选；若环境变量设置了 token，则必须匹配才启用
- `X-Uptimer-Trace-Mode: <mode>`：可选；Worker 热路径与 Pages Worker 均支持 `bypass-cache`

注意：

- 共享排查命令时不要包含真实 `X-Uptimer-Trace-Token`。
- `X-Uptimer-Trace-Id` 用于关联请求，不应包含用户身份、邮箱、真实域名或其他可识别信息。

Token 的环境变量（两处都支持）：

- `UPTIMER_TRACE_TOKEN`（推荐）
- `TRACE_TOKEN`（兼容备用）

### 2.2 Header 协议（响应端）

开启后，响应会包含：

- `X-Uptimer-Trace-Id`：本次 trace id
- `X-Uptimer-Trace`：轻量标签（`key=value;key=value`），用于快速看“路径/命中/age”等
- `Server-Timing`：span 列表，浏览器 DevTools 或 `curl -I` 可直接读

span 前缀约定：

- Worker API（TS Worker）：通常以 `w_` 前缀输出（由调用方传入 prefix）
- Pages Worker（`apps/web/public/_worker.js`，仅 `pages` 模式）：以 `p_` 表示页面层 span，并把 API 的 `Server-Timing` 重命名为 `api_*` 合并进来，方便端到端阅读
- span 名和标签只应表达执行路径、cache 命中、age、payload 形态等低敏信息；不要写入 token、header 原文、完整目标 URL 或用户输入。

---

## 3. Worker（API）侧的 Trace 实现位置

- Trace 实现：`apps/worker/src/observability/trace.ts`
- 热路径启用点（避免全量路由引入额外 CPU）：
  - `apps/worker/src/fetch-handler.ts`：对 `/api/v1/public/homepage`、`/api/v1/public/homepage-artifact`、`/api/v1/public/status` 走“public hot path”并支持 trace
  - `apps/worker/src/routes/public.ts`：部分路径也有 Trace（历史实现）

使用示例：

```bash
# 看 public/homepage 的 span + 标签
curl -sS -D - -o /dev/null \
  -H 'X-Uptimer-Trace: 1' \
  -H 'X-Uptimer-Trace-Token: <token>' \
  -H 'X-Uptimer-Trace-Mode: bypass-cache' \
  'https://<your-worker-origin>/api/v1/public/homepage'
```

你会看到类似：

- `Server-Timing: w_homepage_snapshot_read;dur=... , w_total;dur=...`
- `X-Uptimer-Trace: route=public/homepage;path=snapshot;age=...`

---

## 4. Pages Worker（HTML 注入层）的 Trace 实现位置

- Pages Worker：`apps/web/public/_worker.js`（默认 `pages` 部署模式）
- 行为：
  - 当 HTML 导航请求携带 `X-Uptimer-Trace`（且 token 校验通过）时：
    - Pages Worker 会在自身逻辑中记录 `p_*` span（cache 命中、index fetch、API fetch、注入等）
    - 同时把同一组 trace header 转发到 API（用于拿到 API 的 `Server-Timing` + `X-Uptimer-Trace`）
    - 最终把 API 的 timing 合并成 `api_*` 输出到页面响应
  - `X-Uptimer-Trace-Mode: bypass-cache`：
    - Pages Worker 会跳过 `caches.default.match` 与 `caches.default.put`
    - 适合定位“真实注入成本”，避免缓存把问题掩盖

使用示例（直接观测 HTML 注入链路）：

```bash
curl -sS -D - -o /dev/null \
  -H 'Accept: text/html' \
  -H 'X-Uptimer-Trace: 1' \
  -H 'X-Uptimer-Trace-Token: <token>' \
  -H 'X-Uptimer-Trace-Mode: bypass-cache' \
  'https://<your-pages-origin>/'
```

> **部署模式说明**：
>
> - 默认 `pages` 模式下，首屏 HTML 预注入由 Pages Worker 完成；端到端 trace 会同时输出 `p_*` 与 `api_*` span。
> - 可选 `single_worker` 模式下，SPA 静态资源直接由 Worker `[assets]` 提供，没有 Pages Worker 中间代理层（不经过 `_worker.js`，首屏由 SPA 运行时拉取 `/api/v1/public/homepage`），端到端排查直接观测 Worker 的 `w_*` span。

---

## 5. 推荐的性能排查流程（CPU 优化专用）

1. **先看 Metrics**：确认分位数是否真的回归/改善（以 P50/P90 为主）
2. **用 `wrangler tail` 找链路**：确定哪个 URL/方法的 `cpuTime` 在高分位贡献最大
3. **对该链路开 Trace**：用 `Server-Timing` 拆解 span，明确慢在“读/算/写/协调”的哪一段
4. **只在 Dev 环境做放大实验**：
   - 增加更细的 span（但要保证默认关闭 + token 保护）
   - 用 `bypass-cache` 排除缓存影响
   - 原始 tail/trace 输出保存到 gitignored 临时目录，汇报时只贴脱敏后的聚合摘要
5. **最终回到 Metrics 验证**：任何本地解释都不能替代线上分位数变化

---

## 6. 常见误区（已踩坑总结）

- **把 Pages Worker 当作“免费搬运层”**：Pages Worker 的 CPU 也计入指标，热路径逻辑会直接推高 P50/P90
- **在热路径里做“顺手回写/协调”**：即使“顺手”，也可能成为性能税
- **bench 变快 ≠ Metrics 变快**：在 Cloudflare 的真实链路中，协调/解析/比较的 CPU 往往比“纯计算”更贵
- **Trace 默认开**：会造成性能税与潜在信息泄露；必须默认关闭、可 token gate、只在必要路径启用
