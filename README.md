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
- **One-click deploy** — Push to `main` and GitHub Actions handles everything: D1 migrations, Worker deployment, Pages build.
- **Full-featured** — HTTP/TCP checks, incident management, maintenance windows, webhook notifications, admin dashboard.

## Features

**Monitoring**

- HTTP(S) probes with custom headers, body, status code & keyword assertions
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

```
                ┌──────────────────────────────────────────┐
                │            Cloudflare Network            │
                │                                          │
Visitors ──────►│  Pages (React SPA)                       │
                │      │                                   │
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

## Tech Stack

| Layer           | Technology                                                         |
| --------------- | ------------------------------------------------------------------ |
| Frontend        | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, Recharts |
| Backend         | Cloudflare Workers, Hono, Zod                                      |
| Database        | Cloudflare D1 (SQLite), Drizzle ORM                                |
| Hosting         | Cloudflare Pages (frontend), Workers (API)                         |
| CI/CD           | GitHub Actions                                                     |
| Package Manager | pnpm (monorepo)                                                    |

## Quick Deploy (5 Steps)

Deploy your own Uptimer instance without touching any code or config files:

### Step 1 — Fork

Click the **Fork** button at the top-right of this repository to create your own copy.

### Step 2 — Create a Cloudflare API Token

1. Go to [Cloudflare Dashboard → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token** → use the **Edit Cloudflare Workers** template
3. Add the following permissions:
   - `Account / Cloudflare Pages / Edit`
   - `Account / D1 / Edit`
   - `Account / Account Settings / Read`
4. Copy the generated token

### Step 3 — Add GitHub Secrets

Go to your forked repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, and add:

| Secret Name             | Value                                                                                                         |  Required   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | :---------: |
| `CLOUDFLARE_API_TOKEN`  | Token from Step 2                                                                                             |     Yes     |
| `UPTIMER_ADMIN_TOKEN`   | Any strong string (this is your admin dashboard password)                                                     |     Yes     |
| `CLOUDFLARE_ACCOUNT_ID` | Your [Cloudflare Account ID](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/) | Recommended |

### Step 4 — Run GitHub Actions

Go to **Actions** → **Deploy to Cloudflare** → **Run workflow** (or simply push a commit to `main`/`master`).

The workflow automatically:

- Creates the D1 database and runs migrations
- Deploys the Worker (API + cron-based monitoring)
- Builds and deploys the Pages frontend (status page)
- Injects the admin token as a Worker secret

### Step 5 — Visit Your Status Page

Once the workflow succeeds (usually ~2 min for first deploy):

- **Status page** → `https://<your-repo-name>.pages.dev`
- **Admin dashboard** → `https://<your-repo-name>.pages.dev/admin`
- **API** → `https://<your-repo-name>.workers.dev/api/v1/public/status`

Log in to the admin dashboard with the `UPTIMER_ADMIN_TOKEN` you set, and start adding monitors.

> **Staying up to date** — Since you deploy from your own fork, you can [sync with upstream](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork) at any time. The deploy workflow will run automatically after each sync.

> For advanced options (custom domain, resource naming, admin path), see the [Deployment Guide](docs/deploy-github-actions.md).

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
