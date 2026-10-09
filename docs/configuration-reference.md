# Configuration Reference

English | [中文](configuration-reference.zh-CN.md)

All configurable parameters for Uptimer, organized by context: deployment, runtime, and local development.

## 1. GitHub Actions (Deployment)

Source: `.github/workflows/deploy.yml`

### Secrets

| Name                    | Required         | Description                                                                      |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Yes              | Cloudflare API authentication (deploy Worker/Pages, manage D1)                   |
| `CLOUDFLARE_ACCOUNT_ID` | No (recommended) | Cloudflare Account ID; auto-resolved if not provided                             |
| `UPTIMER_ADMIN_TOKEN`   | Yes              | Admin dashboard access key; written to Worker Secret `ADMIN_TOKEN` automatically |
| `VITE_ADMIN_PATH`       | No               | Override admin dashboard path (takes priority over variable)                     |

### Variables

| Name                    | Default                   | Description                                                                         |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `UPTIMER_PREFIX`        | Repository name slug      | Unified resource name prefix                                                        |
| `UPTIMER_WORKER_NAME`   | `${UPTIMER_PREFIX}`       | Worker name                                                                         |
| `UPTIMER_PAGES_PROJECT` | `${UPTIMER_PREFIX}`       | Pages project name                                                                  |
| `UPTIMER_D1_NAME`       | `${UPTIMER_PREFIX}`       | D1 database name                                                                    |
| `UPTIMER_D1_BINDING`    | `DB`                      | D1 binding name in Worker                                                           |
| `UPTIMER_API_BASE`      | Auto-derived or `/api/v1` | API address (e.g. `https://my-worker.example.com/api/v1` or `/api/v1`)              |
| `UPTIMER_API_ORIGIN`    | Auto-derived              | API origin (e.g. `https://my-worker.example.com`); `/api/v1` appended automatically |
| `VITE_ADMIN_PATH`       | —                         | Admin dashboard path (overridden by Secret if set)                                  |
| `UPTIMER_ADMIN_PATH`    | —                         | Fallback variable for `VITE_ADMIN_PATH`                                             |

> **API address**: Usually no configuration needed — the workflow detects the Worker URL automatically. Set `UPTIMER_API_BASE` or `UPTIMER_API_ORIGIN` only if the API is on a custom domain. Both accept the same information in different formats; setting one is enough.

## 2. Worker Runtime

### Secrets

| Name          | Required | Description            |
| ------------- | -------- | ---------------------- |
| `ADMIN_TOKEN` | Yes      | Admin API Bearer Token |

### Environment Variables

Source: `apps/worker/wrangler.toml` and `apps/worker/src/env.ts`

| Name                          | Default | Description                                    |
| ----------------------------- | ------- | ---------------------------------------------- |
| `ADMIN_RATE_LIMIT_MAX`        | `60`    | Max requests per rate-limit window (admin API) |
| `ADMIN_RATE_LIMIT_WINDOW_SEC` | `60`    | Rate-limit window duration in seconds          |

## 3. Web Build

Source: `apps/web/.env.example`

| Name              | Default   | Description                        |
| ----------------- | --------- | ---------------------------------- |
| `VITE_ADMIN_PATH` | `/admin`  | Admin dashboard route prefix       |
| `VITE_API_BASE`   | `/api/v1` | API base URL for frontend requests |

> `VITE_API_BASE` is injected by the deploy workflow from `UPTIMER_API_BASE`, `UPTIMER_API_ORIGIN`, or the Worker URL. Falls back to `/api/v1` if none are available.

## 4. Runtime Settings (D1)

Source: `apps/worker/src/schemas/settings.ts`

Configurable via Admin API: `PATCH /api/v1/admin/settings`

| Key                               | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `site_title`                      | Status page title                                               |
| `site_description`                | Status page description                                         |
| `site_locale`                     | Site language (`auto` / `en` / `zh-CN` / `zh-TW` / `ja` / `es`) |
| `site_timezone`                   | IANA timezone identifier                                        |
| `retention_check_results_days`    | Days to retain `check_results` data                             |
| `state_failures_to_down_from_up`  | Consecutive failures required for UP -> DOWN transition         |
| `state_successes_to_up_from_down` | Consecutive successes required for DOWN -> UP transition        |
| `admin_default_overview_range`    | Default time range for admin overview                           |
| `admin_default_monitor_range`     | Default time range for admin monitor detail                     |
| `uptime_rating_level`             | Uptime rating thresholds                                        |

## 5. Local Development

### Worker

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Minimum configuration:

```dotenv
ADMIN_TOKEN=changeme
```

### Web

```bash
cp apps/web/.env.example apps/web/.env
```

Optional overrides:

```dotenv
VITE_ADMIN_PATH=/admin
```

## 6. Security Notes

- `ADMIN_TOKEN` must only be stored in Worker Secrets or local `.dev.vars`. Never commit to Git.
- In GitHub Actions, always use Secrets for sensitive values — never Variables.
- Webhook signing secrets must reference Worker Secrets (never stored in the database).
