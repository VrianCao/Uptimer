# 部署指南（GitHub Actions）

[English](deploy-github-actions.md) | 中文

通过仓库内置的 GitHub Actions 工作流将 Uptimer 部署到 Cloudflare。

## 前置要求

- GitHub 仓库（默认分支为 `master` 或 `main`）
- Cloudflare 账号
- 具有部署权限的 Cloudflare API Token
- 仓库 Settings > Secrets and Variables 的配置权限

## 工作流概览

**触发方式**：推送到 `main`/`master`，或手动触发 `workflow_dispatch`

**配置文件**：`.github/workflows/deploy.yml`

**部署模式**（仓库变量 `UPTIMER_DEPLOY_MODE`，或 `workflow_dispatch` 输入 `deploy_mode`）：

| 模式            | 是否默认 | 部署内容                                                 |
| --------------- | -------- | -------------------------------------------------------- |
| `pages`         | 是       | Worker（API + 定时任务）+ Cloudflare Pages SPA           |
| `single_worker` | 否       | 单个 Worker 同时提供 SPA 静态资源与 API（无 Pages 项目） |

手动触发时的优先级：`workflow_dispatch` 输入 `deploy_mode` > 仓库变量 `UPTIMER_DEPLOY_MODE` > 默认 `pages`。输入项默认为 `auto`，即沿用仓库变量。

> **部署模式注意事项**：
>
> - **预加载行为**：在 `pages` 模式下，Pages 代理层（`apps/web/public/_worker.js`）会在首屏 HTML 中直接预注入首页快照数据以提升首屏渲染速度。而在 `single_worker` 模式下，无 HTML 预注入，首屏页面在 SPA 加载后由客户端请求 `/api/v1/public/homepage` 完成渲染。
> - **模式切换**：如果将现有的 `pages` 部署切换为 `single_worker`，原本的 Cloudflare Pages 项目仍然存在于你的 Cloudflare 账户中，需要手动删除或配置重定向，以避免访问到旧版本的页面。

**执行步骤（按顺序）**：

1. 安装 Node + pnpm + 依赖
2. 解析 Cloudflare Account ID（优先读配置，回退到 API 查询）
3. 计算资源命名（Worker / Pages / D1）并校验 `UPTIMER_DEPLOY_MODE`
4. 检查或创建 D1 数据库，注入真实 `database_id` 到临时 `wrangler.ci.toml`
5. 在 `single_worker` 模式下向临时 `wrangler.ci.toml` 注入 Worker `[assets]`
6. 远程执行 D1 迁移
7. 部署 Worker
   - `pages`：仅 API Worker（基础配置不包含 `[assets]`）
   - `single_worker`：SPA + API 通过注入的 `[assets]` 一起上传
8. （可选）写入 Worker Secret：`ADMIN_TOKEN`
9. **仅 pages 模式**：解析 API base/origin，构建 Vite SPA，创建/部署 Pages 项目，设置 Pages Secret `UPTIMER_API_ORIGIN`

## 配置说明

### 必需密钥

| 名称                   | 必需 | 说明                                                    |
| ---------------------- | ---- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | 是   | Cloudflare API 认证                                     |
| `UPTIMER_ADMIN_TOKEN`  | 是   | 管理面板访问密钥；自动写入 Worker 的 `ADMIN_TOKEN` 密钥 |

> 默认 `pages` 模式需要 `Account / Cloudflare Pages / Edit` 权限。`single_worker` 模式不需要 Pages 权限。

### 推荐密钥

| 名称                    | 说明             |
| ----------------------- | ---------------- |
| `CLOUDFLARE_ACCOUNT_ID` | 避免自动解析失败 |

### 可选变量

覆盖默认命名，或切换部署模式：

| 名称                                     | 默认值               | 说明                                                                                     |
| ---------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `UPTIMER_PREFIX`                         | 仓库名 slug          | 统一资源名前缀                                                                           |
| `UPTIMER_WORKER_NAME`                    | `${UPTIMER_PREFIX}`  | Worker 名称                                                                              |
| `UPTIMER_PAGES_PROJECT`                  | `${UPTIMER_PREFIX}`  | Pages 项目名（仅 `pages` 模式）                                                          |
| `UPTIMER_D1_NAME`                        | `${UPTIMER_PREFIX}`  | D1 数据库名                                                                              |
| `UPTIMER_D1_BINDING`                     | `DB`                 | Worker 中 D1 binding 名称                                                                |
| `UPTIMER_DEPLOY_MODE`                    | `pages`              | `pages` 或 `single_worker`；手动触发时也可用输入项 `deploy_mode`                         |
| `UPTIMER_API_BASE`                       | 自动推导或 `/api/v1` | 完整 API 地址（如 `https://my-worker.example.com/api/v1` 或 `/api/v1`）；仅 `pages` 模式 |
| `UPTIMER_API_ORIGIN`                     | 自动推导             | API 域名来源（如 `https://my-worker.example.com`，自动追加 `/api/v1`）；仅 `pages` 模式  |
| `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` | —                    | 自定义管理后台路径                                                                       |

> 若不配置命名变量，工作流会使用仓库名 slug 作为默认前缀。这在 fork 场景下能保持命名稳定。
>
> **API 地址（`pages` 模式）**：SPA 构建时写入 `VITE_API_BASE`（默认 `<worker>/api/v1`）。Pages advanced-mode worker 在配置了 `UPTIMER_API_ORIGIN` 时也会把 `/api/*` 代理到 Worker。
>
> **API 地址（`single_worker` 模式）**：无需配置——前端与 API 共用 Worker 来源，SPA 以相对路径调用 `/api/v1`。

## Cloudflare Token 权限

工作流会创建和更新多个资源，你的 Token 需要以下权限：

- Workers 脚本：部署与管理密钥
- Cloudflare Pages：创建项目与部署（默认 `pages` 模式）
- D1：查询、创建与迁移数据库
- 账号：读取账号信息（用于 Account ID 解析）

## 首次部署

1. 在仓库 Secrets 中添加 `CLOUDFLARE_API_TOKEN`
2. 添加 `UPTIMER_ADMIN_TOKEN`（管理面板访问密钥）
3. 添加 `CLOUDFLARE_ACCOUNT_ID`（推荐）
4. （可选）设置 `UPTIMER_PREFIX`，避免与其他实例重名
5. （可选）设置变量 `UPTIMER_DEPLOY_MODE=single_worker`，或手动运行工作流时选择 `deploy_mode`
6. 推送到 `master`/`main`，或手动触发 "Deploy to Cloudflare"
7. 工作流成功后，从日志中记录访问地址：
   - `pages`：状态页在 `*.pages.dev`，API 在 `*.workers.dev`
   - `single_worker`：状态页、管理后台与 API 都在 Worker URL

> **手动 `wrangler deploy`**：`apps/worker/wrangler.toml` 基础配置不包含 `[assets]`，直接执行 `wrangler deploy` 会部署 API-only Worker。如需 `single_worker` 部署，请走 GitHub Actions（CI 会向 `wrangler.ci.toml` 动态注入 `[assets]`）或手动添加 `[assets]` 配置。

## 部署后验证

### 检查状态页

- `pages`：访问 `https://<pages-项目名>.pages.dev`（管理后台在 `/admin`）
- `single_worker`：访问 `https://<worker-名>.workers.dev`（管理后台在 `/admin`）

### 测试 API

```bash
# 公开 API（single_worker：与状态页使用同一域名）
curl https://<worker-url>/api/v1/public/status

# 管理 API
curl https://<worker-url>/api/v1/admin/monitors \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>"
```

### 验证数据库（可选）

使用 Wrangler 检查 D1 中关键表是否存在：

```
monitors, monitor_state, check_results, outages, settings
```

## 故障排除

### "Resolve Cloudflare Account ID" 失败

- 确认 `CLOUDFLARE_API_TOKEN` 已设置且有效
- 确认 Token 具有账号读取权限
- 直接设置 `CLOUDFLARE_ACCOUNT_ID` 跳过自动解析

### D1 迁移失败

- 检查 `UPTIMER_D1_BINDING` 是否与 `apps/worker/wrangler.toml` 中的 binding 一致
- 确认迁移 SQL 是幂等的且语法正确

### 静态资源或 SPA 路由返回 404（`single_worker` 模式）

- 确认 `Build Web (Vite, single_worker)` 步骤在 `Deploy Worker` 之前已生成 `apps/web/dist`
- 确认 CI 生成的 `wrangler.ci.toml` 仍包含 `[assets]`（`UPTIMER_DEPLOY_MODE=single_worker` 时由 CI 注入）
- `/admin` 等深链接依赖 SPA fallback；本地开发请使用 `:5173` 的 Vite 服务器

### 状态页能打开但 API 调用失败（`pages` 模式）

- 确认 Pages 项目已创建，且 `Deploy Pages` 在 Worker 部署之后执行
- 检查 Pages Secret `UPTIMER_API_ORIGIN` 是否指向 Worker origin（工作流会 best-effort 设置）
- 确认构建产物中包含 `apps/web/public/_worker.js`（Vite 会拷贝 `public/`）

### 管理端返回 401

- 确认 `UPTIMER_ADMIN_TOKEN` 已写入 Worker Secret
- 检查浏览器 localStorage 中的 token 是否与 Secret 一致

## 回滚

优先重新部署上一个已知可用的 commit：

1. 找到上一个绿色部署 commit
2. 基于该 commit 重新触发 "Deploy to Cloudflare"
3. 若涉及 Schema 变更，通过新增前向兼容 migration 修复，而非回滚

> D1 迁移不应做破坏性回滚。若远程迁移已执行，请通过新增 migration 向前修复。

## 与 CI 的关系

| 工作流       | 用途                            |
| ------------ | ------------------------------- |
| `ci.yml`     | 质量门禁：lint、typecheck、test |
| `deploy.yml` | 生产发布                        |

推荐的分支策略：

- PR 合并前必须通过 CI
- `master`/`main` 仅接收经过 Review 的变更
- 发布由 push 自动触发，避免手工漂移
