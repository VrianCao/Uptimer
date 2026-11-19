<div align="center">

# Uptimer

**基于 Cloudflare 边缘网络的 Serverless 可用性监控与状态页**

[![CI](https://github.com/VrianCao/Uptimer/actions/workflows/ci.yml/badge.svg)](https://github.com/VrianCao/Uptimer/actions/workflows/ci.yml)
[![Deploy](https://github.com/VrianCao/Uptimer/actions/workflows/deploy.yml/badge.svg)](https://github.com/VrianCao/Uptimer/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

监控你的服务，向访客展示实时状态，并在服务异常时发送通知 — 全部运行在 Cloudflare Workers + Pages + D1 上，零运维。

[快速部署](#快速部署5-步完成) · [本地开发](#本地开发) · [文档](#文档) · [贡献指南](CONTRIBUTING.zh-CN.md)

**[English](README.md)** | 中文

</div>

---

## 为什么选择 Uptimer？

- **零运维** — 无需管理服务器、容器或数据库。完全运行在 Cloudflare 的免费/付费套餐上。
- **边缘原生** — 监控探针从 Cloudflare Workers 发起，状态页由 CDN 边缘节点分发。
- **审阅后部署** — GitHub Actions 先完成 CI 和构建，通过手动 plan/apply 将同一份已审阅包部署到 Workers + Pages 或 Workers Assets。
- **功能完整** — HTTP/TCP 探测、事件管理、维护窗口、Webhook 通知、管理后台。

## 功能特性

**监控**

- HTTP(S) 探测，支持自定义 Headers、Body、状态码白名单/黑名单（精确码与区间）与关键词断言
- TCP 端口连通性检测
- 可配置的超时、重试阈值与抖动控制
- 自动状态机：UP / DOWN / MAINTENANCE / PAUSED / UNKNOWN

**状态页**

- 面向公众的状态页，实时展示聚合状态
- 每个监控项的可用率百分比与延迟图表
- 当前活跃的事件与维护窗口
- 多语言支持（en、zh-CN、zh-TW、ja、es）

**事件管理**

- 创建、更新、解决事件，附带时间线
- 计划维护窗口
- 所有事件在公共状态页可见

**通知**

- Webhook 通知至 Discord、Slack、ntfy 或任意 HTTP 端点
- 可自定义的消息与 Payload 模板，支持魔法变量
- 可选的 HMAC-SHA256 签名验证
- 幂等投递与去重

**管理后台**

- 监控项 CRUD 与实时状态概览
- 通知渠道管理，支持测试按钮
- 分析面板，含可用率/延迟图表与 CSV 导出
- 系统设置（站点标题、时区、阈值、数据保留）

## 架构

默认部署形态为 **Pages + Workers**（前后端分离）。也可选用 **single_worker** 模式，将 SPA 与 API 部署到同一个 Worker 域名。

```
                ┌──────────────────────────────────────────┐
                │            Cloudflare Network            │
                │                                          │
Visitors ──────►│  Pages (React SPA)                       │
                │      │  /api/*  →  代理到 Worker         │
                │      ▼                                   │
Admin ─────────►│  Workers (Hono API)                      │
                │      │              │                    │
                │      ▼              ▼                    │
                │    D1 DB      Cron Triggers              │
                │              (定时探测)                  │
                │                     │                    │
                └─────────────────────┼────────────────────┘
                                      │
                                      ▼
                           Target Services (HTTP/TCP)
                                      │
                                      ▼
                              Webhooks ──► Discord / Slack / ntfy
```

**默认（`pages`）**：状态页与管理后台部署在 Cloudflare Pages；Worker 负责 API 与定时探测。Pages 通过 `apps/web/public/_worker.js` 将 `/api/*` 代理到 Worker，并在首屏 HTML 中预注入首页快照数据。

**可选（`single_worker`）**：设置 GitHub Actions 变量 `UPTIMER_DEPLOY_MODE=single_worker`，构建后的 SPA 会作为 Worker 的 `[assets]` 上传。状态页、管理后台与 API 共用同一域名（无需 Pages 项目）。注意：首屏需在 SPA 加载后请求 `/api/v1/public/homepage` 完成渲染（无 HTML 预注入）；若从现有 `pages` 切换到此模式，需手动删除旧的 Pages 项目或配置重定向。

## 技术栈

| 层级   | 技术                                                               |
| ------ | ------------------------------------------------------------------ |
| 前端   | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, Recharts |
| 后端   | Cloudflare Workers, Hono, Zod                                      |
| 数据库 | Cloudflare D1 (SQLite), Drizzle ORM                                |
| 托管   | Cloudflare Pages（前端）+ Workers（API）；可选单 Worker 模式       |
| CI/CD  | GitHub Actions                                                     |
| 包管理 | pnpm（monorepo）                                                   |

## 部署 Uptimer

1. Fork 本仓库，在 Fork 的 **Actions** 页面启用工作流。
2. 添加仓库 Secrets `CLOUDFLARE_API_TOKEN` 和 `UPTIMER_ADMIN_TOKEN`。
3. 在 **Actions → Deploy to Cloudflare** 运行 `plan`，核对摘要后在同一提交运行 `apply`。验收通过后，从运行摘要打开状态页。

[v0.2.0 部署与升级指南](docs/v0.2.0-upgrade.zh-CN.md) · [通用部署指南](docs/deploy-github-actions.zh-CN.md) · [升级与恢复](docs/upgrade-and-recovery.md)

通过 **Sync fork** 更新代码。Cloudflare 部署由你手动发起。

---

## 让 Agent 协助升级到 v0.2.0

把下面的提示词复制给能访问你的 GitHub 仓库的 Agent。它可以帮你核对升级路径，或者在你授权后代你运行 Action。

<details>
<summary>复制升级提示词</summary>

```text
帮我把自己的 Uptimer 站点升级到 v0.2.0。请用中文直白、直观、简洁地和我沟通，优先说「现在是什么情况、下一步做什么、站点会受什么影响」。一次只问一个会影响下一步的问题。你能查到的信息就自己查。

1. 先做只读核对。识别我的 fork、目标分支和提交、上游已发布的目标版本、Actions 状态、自定义部署触发器和最近的部署结果。阅读目标版本的 docs/v0.2.0-upgrade.zh-CN.md 和实际 deploy.yml。判断是首装、已有站点升级、维护中续跑，还是只同步了代码。结合可用的配置和 Plan 核对现有 Worker、D1、托管方式与 free/paid 运行配置，分清已确认和未知的信息。
2. 给我最短的操作路径。需要同步时，先说明自定义流程会不会自动部署，以及有无冲突。已有实例沿用原托管方式和运行配置。默认 free 可留空，通常由 Plan 查到账户和 D1。若缺少配置或权限，只告诉我具体缺哪一项和到哪里处理。请在 GitHub Secrets 页面引导我设置密钥，聊天和日志里都不要索取或显示密钥值。
3. 我授权了哪一步，就在我的 fork 和指定分支执行哪一步。若获准代办，使用 GitHub 的 Deploy to Cloudflare Action。先运行只读 Plan，告诉我摘要中的目标提交、账户、Worker、D1、Pages（如有）、待迁移项和维护影响。得到对该 Plan 的 Apply 授权后，在同一提交填写 plan_run 和 plan_hash 触发 Apply。提交或目标变化时重新核对；有 BLOCKED 时停在 Plan 并解释原因。
4. 若目标版本已上线且站点正常，直接告诉我。触发 Action 后跟踪到结束，再给我一句结果、运行链接和状态页链接。已经进入维护的 Apply 中断时，优先在授权范围内续跑原 Apply。对冲突、配置变更、数据库重置或恢复，先说明影响并征得对应授权。若你只能指导我操作，给我 GitHub 上的点击路径和这一步要填的值。
```

</details>

---

## 本地开发

<details>
<summary>点击展开本地开发环境配置</summary>

### 前置要求

- Node.js >= 22.14.0
- pnpm >= 10.8.1

### 配置步骤

```bash
# 1. 克隆并安装依赖
git clone https://github.com/<your-username>/Uptimer.git
cd Uptimer
pnpm install

# 2. 配置本地密钥
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# 编辑 .dev.vars，设置 ADMIN_TOKEN=your-secret-token

# 3. 一键初始化并启动开发服务器
pnpm dev
```

默认地址：

- **状态页**：http://localhost:5173
- **管理后台**：http://localhost:5173/admin
- **API**：http://localhost:8787/api/v1

> 完整的本地开发指南（种子数据、API 测试、常见问题）请参阅 [Develop/LOCAL-TESTING.md](Develop/LOCAL-TESTING.md)。

</details>

## 文档

| 文档                                                  | 说明                               |
| ----------------------------------------------------- | ---------------------------------- |
| [v0.2.0 部署与升级指南](docs/v0.2.0-upgrade.zh-CN.md) | 版本说明、首装、升级和续跑         |
| [部署指南](docs/deploy-github-actions.zh-CN.md)       | GitHub Actions 部署完整流程        |
| [配置参考](docs/configuration-reference.zh-CN.md)     | 所有可配置参数（密钥、变量、设置） |
| [通知系统](docs/notifications.zh-CN.md)               | Webhook 配置、模板、签名、故障排除 |
| [本地开发](Develop/LOCAL-TESTING.md)                  | 本地环境搭建、种子数据、测试流程   |

## 质量检查

```bash
pnpm lint          # ESLint 全包检查
pnpm typecheck     # TypeScript 严格类型检查
pnpm test          # 单元测试
pnpm format:check  # Prettier 格式检查
```

## 贡献

欢迎贡献！请参阅 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) 了解详情。

## 许可证

本项目基于 MIT 许可证开源 — 详见 [LICENSE](LICENSE) 文件。

---

<div align="center">

基于 [Cloudflare Workers](https://workers.cloudflare.com/) + [Hono](https://hono.dev/) + [React](https://react.dev/) 构建

感谢 [UptimeFlare](https://github.com/lyc8503/UptimeFlare) 在 Cloudflare 原生可用性监控模式上带来的启发。

</div>
