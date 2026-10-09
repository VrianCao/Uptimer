# 配置参考

[English](configuration-reference.md) | 中文

Uptimer 所有可配置参数，按部署时、运行时、本地开发分类。

## 1. GitHub Actions（部署时）

来源：`.github/workflows/deploy.yml`

### Secrets

| 名称                    | 必需       | 说明                                                   |
| ----------------------- | ---------- | ------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | 是         | Cloudflare API 认证（部署 Worker/Pages、管理 D1）      |
| `CLOUDFLARE_ACCOUNT_ID` | 否（推荐） | Cloudflare Account ID；未提供时工作流尝试自动解析      |
| `UPTIMER_ADMIN_TOKEN`   | 是         | 管理面板访问密钥；自动写入 Worker Secret `ADMIN_TOKEN` |
| `VITE_ADMIN_PATH`       | 否         | 覆盖管理后台路径（优先级高于 Variable）                |

### Variables

| 名称                    | 默认值               | 说明                                                                 |
| ----------------------- | -------------------- | -------------------------------------------------------------------- |
| `UPTIMER_PREFIX`        | 仓库名 slug          | 统一资源名前缀                                                       |
| `UPTIMER_WORKER_NAME`   | `${UPTIMER_PREFIX}`  | Worker 名称                                                          |
| `UPTIMER_PAGES_PROJECT` | `${UPTIMER_PREFIX}`  | Pages 项目名                                                         |
| `UPTIMER_D1_NAME`       | `${UPTIMER_PREFIX}`  | D1 数据库名                                                          |
| `UPTIMER_D1_BINDING`    | `DB`                 | Worker 中 D1 binding 名称                                            |
| `UPTIMER_API_BASE`      | 自动推导或 `/api/v1` | API 地址（如 `https://my-worker.example.com/api/v1` 或 `/api/v1`）   |
| `UPTIMER_API_ORIGIN`    | 自动推导             | API 源地址（如 `https://my-worker.example.com`）；自动拼接 `/api/v1` |
| `VITE_ADMIN_PATH`       | —                    | 管理后台路径（可被 Secret 覆盖）                                     |
| `UPTIMER_ADMIN_PATH`    | —                    | 兼容变量名（`VITE_ADMIN_PATH` 的 fallback）                          |

> **API 地址**：通常无需配置——工作流会自动从 Worker URL 推导。仅当 API 使用自定义域名时，设置 `UPTIMER_API_BASE` 或 `UPTIMER_API_ORIGIN` 其中一个即可，两者只是格式不同。

## 2. Worker 运行时

### Secrets

| 名称          | 必需 | 说明                    |
| ------------- | ---- | ----------------------- |
| `ADMIN_TOKEN` | 是   | 管理员 API Bearer Token |

### 环境变量

来源：`apps/worker/wrangler.toml` 与 `apps/worker/src/env.ts`

| 名称                          | 默认值 | 说明                            |
| ----------------------------- | ------ | ------------------------------- |
| `ADMIN_RATE_LIMIT_MAX`        | `60`   | 管理端 API 限流窗口内最大请求数 |
| `ADMIN_RATE_LIMIT_WINDOW_SEC` | `60`   | 管理端 API 限流窗口长度（秒）   |

## 3. Web 构建时

来源：`apps/web/.env.example`

| 名称              | 默认值    | 说明                    |
| ----------------- | --------- | ----------------------- |
| `VITE_ADMIN_PATH` | `/admin`  | 管理后台路由前缀        |
| `VITE_API_BASE`   | `/api/v1` | 前端访问 API 的基础 URL |

> `VITE_API_BASE` 由部署工作流自动注入，来源依次为 `UPTIMER_API_BASE`、`UPTIMER_API_ORIGIN`、Worker URL，均不可用时回退为 `/api/v1`。

## 4. 运行时设置（D1）

来源：`apps/worker/src/schemas/settings.ts`

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
