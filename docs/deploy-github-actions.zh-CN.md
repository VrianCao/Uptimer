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

**执行步骤（按顺序）**：

1. 安装 Node + pnpm + 依赖
2. 解析 Cloudflare Account ID（优先读配置，回退到 API 查询）
3. 计算资源命名（Worker / Pages / D1）
4. 检查或创建 D1 数据库，注入真实 `database_id` 到临时 `wrangler.ci.toml`
5. 远程执行 D1 迁移
6. 部署 Worker
7. （可选）写入 Worker Secret：`ADMIN_TOKEN`
8. 构建并部署 Pages
9. （可选）写入 Pages Secret：`UPTIMER_API_ORIGIN`

## 配置说明

### 必需密钥

| 名称                   | 必需 | 说明                                                    |
| ---------------------- | ---- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | 是   | Cloudflare API 认证                                     |
| `UPTIMER_ADMIN_TOKEN`  | 是   | 管理面板访问密钥；自动写入 Worker 的 `ADMIN_TOKEN` 密钥 |

### 推荐密钥

| 名称                    | 说明             |
| ----------------------- | ---------------- |
| `CLOUDFLARE_ACCOUNT_ID` | 避免自动解析失败 |

### 可选变量

覆盖默认命名与路由：

| 名称                                     | 默认值               | 说明                                                                 |
| ---------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `UPTIMER_PREFIX`                         | 仓库名 slug          | 统一资源名前缀                                                       |
| `UPTIMER_WORKER_NAME`                    | `${UPTIMER_PREFIX}`  | Worker 名称                                                          |
| `UPTIMER_PAGES_PROJECT`                  | `${UPTIMER_PREFIX}`  | Pages 项目名                                                         |
| `UPTIMER_D1_NAME`                        | `${UPTIMER_PREFIX}`  | D1 数据库名                                                          |
| `UPTIMER_D1_BINDING`                     | `DB`                 | Worker 中 D1 binding 名称                                            |
| `UPTIMER_API_BASE`                       | 自动推导或 `/api/v1` | API 地址（如 `https://my-worker.example.com/api/v1` 或 `/api/v1`）   |
| `UPTIMER_API_ORIGIN`                     | 自动推导             | API 源地址（如 `https://my-worker.example.com`）；自动拼接 `/api/v1` |
| `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` | —                    | 自定义管理后台路径                                                   |

> 若不配置命名变量，工作流会使用仓库名 slug 作为默认前缀。这在 fork 场景下能保持命名稳定。
>
> **API 地址**：通常无需配置——工作流会自动从 Worker URL 推导。仅当 API 使用自定义域名时，设置 `UPTIMER_API_BASE` 或 `UPTIMER_API_ORIGIN` 其中一个即可，两者只是格式不同。

## Cloudflare Token 权限

工作流会创建和更新多个资源，你的 Token 需要以下权限：

- Workers 脚本：部署与管理密钥
- D1：查询、创建与迁移数据库
- Pages：创建项目与部署
- 账号：读取账号信息（用于 Account ID 解析）

## 首次部署

1. 在仓库 Secrets 中添加 `CLOUDFLARE_API_TOKEN`
2. 添加 `UPTIMER_ADMIN_TOKEN`（管理面板访问密钥）
3. 添加 `CLOUDFLARE_ACCOUNT_ID`（推荐）
4. （可选）设置 `UPTIMER_PREFIX`，避免与其他实例重名
5. 推送到 `master`/`main`，或手动触发 "Deploy to Cloudflare"
6. 工作流成功后，从日志中记录 Worker URL 与 Pages URL

## 部署后验证

### 检查状态页

- 访问 Pages URL（公共状态页）
- 导航到 `/admin`（或你自定义的 `VITE_ADMIN_PATH`）

### 测试 API

```bash
# 公开 API
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

### Pages 构建成功但 API 返回 404 或 HTML

- 确认 `UPTIMER_API_BASE` 或 `UPTIMER_API_ORIGIN` 指向的是 Worker 地址，而非 Pages 地址
- "API returned HTML instead of JSON" 通常意味着请求打到了 Pages（返回 HTML）而非 Worker
- 都未设置时，工作流会自动使用 Worker URL — 检查部署日志中该值是否正确解析

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
