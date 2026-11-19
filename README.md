<div align="center">

# Uptimer

**Serverless uptime monitoring & status page on Cloudflare's edge network**

[![CI](https://github.com/VrianCao/Uptimer/actions/workflows/ci.yml/badge.svg)](https://github.com/VrianCao/Uptimer/actions/workflows/ci.yml)
[![Deploy](https://github.com/VrianCao/Uptimer/actions/workflows/deploy.yml/badge.svg)](https://github.com/VrianCao/Uptimer/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Monitor your services, display real-time status to visitors, and get notified when things go down — all running on Cloudflare Workers + Pages + D1 with zero ops.

[Quick Deploy](#quick-deploy-5-steps) · [Local Dev](#local-development) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md)

English | **[中文](README.zh-CN.md)**

</div>

---

## Why Uptimer?

- **Zero ops** — No servers, containers, or databases to manage. Runs entirely on Cloudflare's free/paid tiers.
- **Edge-native** — Monitoring probes run from Cloudflare Workers; your status page is served from the CDN edge.
- **Reviewed deploy** — GitHub Actions runs CI and builds a package first; manual plan/apply deploys the same reviewed package to Workers + Pages or Workers Assets.
- **Full-featured** — HTTP/TCP checks, incident management, maintenance windows, webhook notifications, admin dashboard.

## Features

**Monitoring**

- HTTP(S) probes with custom headers, body, status code allow/deny lists (exact codes & ranges) & keyword assertions
- TCP port connectivity checks
- Configurable timeouts, retry thresholds, and flapping control
- Automatic state machine: UP / DOWN / MAINTENANCE / PAUSED / UNKNOWN

**Status Page**

- Public-facing status page with real-time aggregate status
- Per-monitor uptime percentage and latency charts
- Active incidents and maintenance windows
- Multi-language support (en, zh-CN, zh-TW, ja, es)

**Incident Management**

- Create, update, and resolve incidents with timeline
- Schedule maintenance windows
- All visible on the public status page

**Notifications**

- Webhook notifications to Discord, Slack, ntfy, or any HTTP endpoint
- Customizable message & payload templates with magic variables
- Optional HMAC-SHA256 signature verification
- Idempotent delivery with deduplication

**Admin Dashboard**

- Monitor CRUD with live status overview
- Notification channel management with test button
- Analytics with uptime/latency charts and CSV export
- System settings (site title, timezone, thresholds, retention)

## Architecture

Default deployment is **Pages + Workers** (decoupled). An optional **single_worker** mode ships the SPA and API from one Worker origin.

```
                ┌──────────────────────────────────────────┐
                │            Cloudflare Network            │
                │                                          │
Visitors ──────►│  Pages (React SPA)                       │
                │      │  /api/*  →  proxy                 │
                │      ▼                                   │
Admin ─────────►│  Workers (Hono API)                      │
                │      │              │                    │
                │      ▼              ▼                    │
                │    D1 DB      Cron Triggers              │
                │              (scheduled probes)          │
                │                     │                    │
                └─────────────────────┼────────────────────┘
                                      │
                                      ▼
                           Target Services (HTTP/TCP)
                                      │
                                      ▼
                              Webhooks ──► Discord / Slack / ntfy
```

**Default (`pages`)**: status page + admin dashboard are deployed to Cloudflare Pages; the Worker serves the API and cron probes. Pages proxies `/api/*` to the Worker via `apps/web/public/_worker.js`, preloading homepage data directly into the initial HTML.

**Optional (`single_worker`)**: set GitHub Actions variable `UPTIMER_DEPLOY_MODE=single_worker` to upload the built SPA as Worker `[assets]`. Frontend, admin, and API then share one origin (no Pages project). Note: first visit renders after the SPA fetches `/api/v1/public/homepage` (no HTML preload injection). If switching from an existing `pages` deployment, manually remove or redirect the old Pages project.

## Tech Stack

| Layer           | Technology                                                          |
| --------------- | ------------------------------------------------------------------- |
| Frontend        | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, Recharts  |
| Backend         | Cloudflare Workers, Hono, Zod                                       |
| Database        | Cloudflare D1 (SQLite), Drizzle ORM                                 |
| Hosting         | Cloudflare Pages (frontend) + Workers (API); optional single Worker |
| CI/CD           | GitHub Actions                                                      |
| Package Manager | pnpm (monorepo)                                                     |

## Deploy Uptimer

1. Fork this repository and enable workflows in your fork’s **Actions** tab.
2. Add `CLOUDFLARE_API_TOKEN` and `UPTIMER_ADMIN_TOKEN` as repository secrets.
3. In **Actions → Deploy to Cloudflare**, run `plan`. Review the summary, then run `apply` at the same commit. Open your status page from the completed run.

[Deployment guide](docs/deploy-github-actions.md) · [Upgrade and recovery](docs/upgrade-and-recovery.md)

Use **Sync fork** to update your code. Cloudflare deployment remains manual.

---

## Local Development

<details>
<summary>Click to expand local development setup</summary>

### Prerequisites

- Node.js >= 22.14.0
- pnpm >= 10.8.1

### Setup

```bash
# 1. Clone and install
git clone https://github.com/<your-username>/Uptimer.git
cd Uptimer
pnpm install

# 2. Set up local secrets
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Edit .dev.vars and set ADMIN_TOKEN=your-secret-token

# 3. Start development servers (auto-initializes D1)
pnpm dev
```

Default addresses:

- **Status page**: http://localhost:5173
- **Admin dashboard**: http://localhost:5173/admin
- **API**: http://localhost:8787/api/v1

> For the full local development guide (seed data, API testing, troubleshooting), see [Develop/LOCAL-TESTING.md](Develop/LOCAL-TESTING.md).

</details>

## Documentation

| Document                                                                                                   | Description                                                |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Deployment Guide](docs/deploy-github-actions.md) ([中文](docs/deploy-github-actions.zh-CN.md))            | Full GitHub Actions deployment walkthrough                 |
| [Configuration Reference](docs/configuration-reference.md) ([中文](docs/configuration-reference.zh-CN.md)) | All configurable parameters (secrets, variables, settings) |
| [Notification System](docs/notifications.md) ([中文](docs/notifications.zh-CN.md))                         | Webhook setup, templates, signatures, troubleshooting      |
| [Local Development](Develop/LOCAL-TESTING.md)                                                              | Local setup, seed data, testing procedures                 |

## Quality Checks

```bash
pnpm lint          # ESLint across all packages
pnpm typecheck     # TypeScript strict checks
pnpm test          # Unit tests
pnpm format:check  # Prettier formatting check
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

Built with [Cloudflare Workers](https://workers.cloudflare.com/) + [Hono](https://hono.dev/) + [React](https://react.dev/)

Thanks to [UptimeFlare](https://github.com/lyc8503/UptimeFlare) for inspiration on Cloudflare-native uptime monitoring patterns.

</div>
