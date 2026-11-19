# 配置参考

[English](configuration-reference.md) | 中文

Uptimer 所有可配置参数，按部署时、运行时、本地开发分类。

## 1. GitHub Actions（部署时）

[部署指南](deploy-github-actions.zh-CN.md)

### Secrets

| 名称                   | 必需 | 说明                                                                 |
| ---------------------- | ---- | -------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | 是   | Cloudflare API 认证（部署 Worker、管理 D1；pages 模式还需 Pages）    |
| `UPTIMER_ADMIN_TOKEN`  | 是   | 管理密钥。首装初始化 Worker Secret `ADMIN_TOKEN`，升级沿用现有密钥。 |
| `VITE_ADMIN_PATH`      | 否   | 覆盖管理后台路径（优先级高于 Variable）                              |

### Variables

| 名称                      | 默认值                       | 说明                                                                                                                    |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`   | 自动识别                     | API 无法返回唯一账户时设置；也接受同名 Secret。                                                                         |
| `UPTIMER_PREFIX`          | 仓库名 slug                  | 统一资源名前缀                                                                                                          |
| `UPTIMER_WORKER_NAME`     | `${UPTIMER_PREFIX}`          | Worker 名称                                                                                                             |
| `UPTIMER_PAGES_PROJECT`   | `${UPTIMER_PREFIX}`          | Pages 项目名（仅 `pages` 模式）                                                                                         |
| `UPTIMER_D1_NAME`         | 已绑定的数据库名或资源前缀   | 选择首装名称，或校验升级时识别到的名称。                                                                                |
| `UPTIMER_D1_ID`           | 来自现有 Worker 的 `DB` 绑定 | 仅在 Worker 尚未部署、需要续跑时手填，也可用于校验指定 UUID。                                                           |
| `UPTIMER_WORKER_URL`      | 自动推导                     | Worker 的 HTTPS 地址。使用自定义域名或未启用 workers.dev 时设置。                                                       |
| `UPTIMER_DEPLOY_MODE`     | `pages`                      | `pages`（Pages + Workers）或 `single_worker`（SPA 挂 Worker assets）；手动触发可用输入项 `deploy_mode` 覆盖             |
| `UPTIMER_RUNTIME_PROFILE` | `free`                       | `free`：站点 DO + D1；`paid`：直接 Worker + D1、30s CPU。独立于托管方式，见[运行配置](../Develop/Runtime-Profiles.md)。 |
| `UPTIMER_API_BASE`        | 自动推导或 `/api/v1`         | 完整 API 地址（如 `https://my-worker.example.com/api/v1` 或 `/api/v1`）；仅 `pages` 模式                                |
| `UPTIMER_API_ORIGIN`      | 自动推导                     | API 域名来源（如 `https://my-worker.example.com`，自动追加 `/api/v1`）；仅 `pages` 模式                                 |
| `VITE_ADMIN_PATH`         | —                            | 管理后台路径（可被 Secret 覆盖）                                                                                        |
| `UPTIMER_ADMIN_PATH`      | —                            | 兼容变量名（`VITE_ADMIN_PATH` 的 fallback）                                                                             |

> **API 地址（`pages` 模式）**：通常无需配置——工作流会自动检测 Worker URL。仅当 API 使用自定义域名时才需设置 `UPTIMER_API_BASE` 或 `UPTIMER_API_ORIGIN`。两者接受不同格式的同类信息，设置任意一个即可。Pages 还会通过 `apps/web/public/_worker.js` 代理 `/api/*`。
>
> **API 地址（`single_worker` 模式）**：无需配置——前端与 API 共用 Worker 来源，SPA 以相对路径调用 `/api/v1`。

## 2. Worker 运行时

### Secrets

| 名称          | 必需 | 说明                    |
| ------------- | ---- | ----------------------- |
| `ADMIN_TOKEN` | 是   | 管理员 API Bearer Token |

### 环境变量

[部署指南](deploy-github-actions.zh-CN.md)

| 名称                          | 默认值 | 说明                            |
| ----------------------------- | ------ | ------------------------------- |
| `ADMIN_RATE_LIMIT_MAX`        | `60`   | 管理端 API 限流窗口内最大请求数 |
| `ADMIN_RATE_LIMIT_WINDOW_SEC` | `60`   | 管理端 API 限流窗口长度（秒）   |

### 静态资源（`[assets]`）

基础 `apps/worker/wrangler.toml` 默认不包含 `[assets]` 配置，使本地 `wrangler dev` 与测试无需依赖预构建前端即可运行。CI 行为：

- `pages` 模式（默认）：生产 Worker 仅提供 API（无 `[assets]`）；前端部署至 Cloudflare Pages
- `single_worker` 模式：CI 动态向 `wrangler.ci.toml` 注入 `[assets]`，SPA 与 Worker 一起发布

## 3. Web 构建时

[部署指南](deploy-github-actions.zh-CN.md)

| 名称              | 默认值    | 说明                    |
| ----------------- | --------- | ----------------------- |
| `VITE_ADMIN_PATH` | `/admin`  | 管理后台路由前缀        |
| `VITE_API_BASE`   | `/api/v1` | 前端访问 API 的基础 URL |

> `VITE_API_BASE` 默认 `/api/v1`。`single_worker`（同源）以及配置了 Pages 代理的 `pages` 模式下都是正确值。CI 在 `pages` 模式下可能会写入 Worker 的绝对地址。

## 4. 运行时设置（D1）

[部署指南](deploy-github-actions.zh-CN.md)

可通过 Admin API `PATCH /api/v1/admin/settings` 更新。

| Key                               | 说明                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `site_title`                      | 状态页标题                                                  |
| `site_description`                | 状态页描述                                                  |
| `site_locale`                     | 站点语言（`auto` / `en` / `zh-CN` / `zh-TW` / `ja` / `es`） |
| `site_timezone`                   | IANA 时区标识符                                             |
| `retention_check_results_days`    | `check_results` 数据保留天数                                |
| `state_failures_to_down_from_up`  | UP -> DOWN 所需连续失败次数                                 |
| `state_successes_to_up_from_down` | DOWN -> UP 所需连续成功次数                                 |
| `admin_default_overview_range`    | 管理后台总览默认时间范围                                    |
| `admin_default_monitor_range`     | 管理后台监控详情默认时间范围                                |
| `uptime_rating_level`             | 可用率评级阈值                                              |

## 5. 本地开发

### Worker

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

最小配置：

```dotenv
ADMIN_TOKEN=changeme
```

### Web

```bash
cp apps/web/.env.example apps/web/.env
```

可选配置：

```dotenv
VITE_ADMIN_PATH=/admin
```

## 6. 安全注意事项

- `ADMIN_TOKEN` 仅能存储在 Worker Secrets 或本地 `.dev.vars` 中，绝不能提交到 Git。
- GitHub Actions 中敏感值必须使用 Secrets，不要放在 Variables 中。
- Webhook 签名密钥必须引用 Worker Secrets（不要存入数据库）。
