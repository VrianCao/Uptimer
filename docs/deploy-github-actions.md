# Deployment Guide (GitHub Actions)

English | [中文](deploy-github-actions.zh-CN.md)

Deploy Uptimer to Cloudflare using the built-in GitHub Actions workflow.

## Prerequisites

- A GitHub repository (default branch: `master` or `main`)
- A Cloudflare account
- A Cloudflare API Token with deployment permissions
- Access to repository Settings > Secrets and Variables

## Workflow Overview

**Trigger**: Push to `main`/`master`, or manual `workflow_dispatch`

**File**: `.github/workflows/deploy.yml`

**Deploy modes** (repository variable `UPTIMER_DEPLOY_MODE`, or `workflow_dispatch` input `deploy_mode`):

| Mode            | Default | What gets deployed                                            |
| --------------- | ------- | ------------------------------------------------------------- |
| `pages`         | Yes     | Worker (API + cron) + Cloudflare Pages SPA                    |
| `single_worker` | No      | One Worker serving SPA static assets + API (no Pages project) |

Priority for manual runs: `workflow_dispatch` input `deploy_mode` > repository variable `UPTIMER_DEPLOY_MODE` > default `pages`.

> **Deploy mode notes**:
>
> - **Preload behavior**: In `pages` mode, the Pages proxy (`apps/web/public/_worker.js`) preloads and injects homepage snapshot data into the initial HTML for faster initial render. In `single_worker` mode, there is no HTML preload injection; the status page renders after the SPA fetches `/api/v1/public/homepage` on load.
> - **Switching modes**: If switching an existing deployment from `pages` to `single_worker`, the existing Pages project remains live in Cloudflare and must be deleted or redirected manually to avoid serving outdated versions.

**Steps (in order)**:

1. Install Node + pnpm + dependencies
2. Resolve Cloudflare Account ID (reads from config, falls back to API query)
3. Compute resource names (Worker / Pages / D1) and validate `UPTIMER_DEPLOY_MODE`
4. Check or create D1 database, inject real `database_id` into temp `wrangler.ci.toml`
5. Inject Worker `[assets]` into temp `wrangler.ci.toml` if `single_worker` mode
6. Run remote D1 migrations
7. Deploy the Worker
   - `pages`: API-only Worker (default base config without `[assets]`)
   - `single_worker`: SPA + API uploaded together via injected `[assets]`
8. (Optional) Write Worker Secret: `ADMIN_TOKEN`
9. **pages mode only**: resolve API base/origin, build Vite SPA, create/deploy Pages project, set Pages secret `UPTIMER_API_ORIGIN`

## Configuration

### Required Secrets

| Name                   | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN` | Yes      | Cloudflare API authentication                                            |
| `UPTIMER_ADMIN_TOKEN`  | Yes      | Admin dashboard access key; auto-injected as Worker `ADMIN_TOKEN` secret |

> Token needs `Account / Cloudflare Pages / Edit` for the default `pages` mode. Single-worker mode does not require Pages permissions.

### Recommended Secrets

| Name                    | Description                     |
| ----------------------- | ------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Avoids auto-resolution failures |

### Optional Variables

Override default naming or switch deploy mode:

| Name                                     | Default                   | Description                                                                                            |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `UPTIMER_PREFIX`                         | Repository name slug      | Unified resource name prefix                                                                           |
| `UPTIMER_WORKER_NAME`                    | `${UPTIMER_PREFIX}`       | Worker name                                                                                            |
| `UPTIMER_PAGES_PROJECT`                  | `${UPTIMER_PREFIX}`       | Pages project name (`pages` mode only)                                                                 |
| `UPTIMER_D1_NAME`                        | `${UPTIMER_PREFIX}`       | D1 database name                                                                                       |
| `UPTIMER_D1_BINDING`                     | `DB`                      | D1 binding name in Worker                                                                              |
| `UPTIMER_DEPLOY_MODE`                    | `pages`                   | `pages` or `single_worker`; also available as `workflow_dispatch` input `deploy_mode`                  |
| `UPTIMER_API_BASE`                       | Auto-derived or `/api/v1` | API address (e.g. `https://my-worker.example.com/api/v1` or `/api/v1`); `pages` mode only              |
| `UPTIMER_API_ORIGIN`                     | Auto-derived              | API origin (e.g. `https://my-worker.example.com`); `/api/v1` appended automatically; `pages` mode only |
| `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` | —                         | Custom admin dashboard path                                                                            |

> If no naming variables are set, the workflow uses the repository name slug as the default prefix. This keeps names stable across forks.
>
> **API address (`pages` mode)**: the SPA is built with `VITE_API_BASE` (defaults to `<worker>/api/v1`). The Pages advanced-mode worker also proxies `/api/*` to the Worker when `UPTIMER_API_ORIGIN` is set.
>
> **API address (`single_worker` mode)**: no configuration needed — frontend and API share the Worker origin; the SPA calls `/api/v1` relatively.

## Cloudflare Token Permissions

The workflow creates and updates multiple resources. Your token needs:

- Workers Scripts: deploy and manage secrets
- Cloudflare Pages: create projects and deploy (default `pages` mode)
- D1: query, create, and migrate databases
- Account: read account info (for account ID resolution)

## First Deployment

1. Add `CLOUDFLARE_API_TOKEN` to repository secrets
2. Add `UPTIMER_ADMIN_TOKEN` (admin dashboard access key)
3. Add `CLOUDFLARE_ACCOUNT_ID` (recommended)
4. (Optional) Set `UPTIMER_PREFIX` to avoid name collisions
5. (Optional) Set variable `UPTIMER_DEPLOY_MODE=single_worker`, or choose `deploy_mode` when running the workflow manually
6. Push to `master`/`main`, or manually trigger "Deploy to Cloudflare"
7. Once the workflow succeeds, note the URLs from the logs:
   - `pages`: status page on `*.pages.dev`, API on `*.workers.dev`
   - `single_worker`: status page, admin, and API on the Worker URL

> **Manual `wrangler deploy`**: `apps/worker/wrangler.toml` contains no `[assets]` block, so a direct `wrangler deploy` deploys an API-only Worker. For `single_worker` deployments, use GitHub Actions (which injects `[assets]` into `wrangler.ci.toml`) or add `[assets]` manually.

## Post-deployment Verification

### Check the Status Page

- `pages`: visit `https://<pages-project>.pages.dev` (admin at `/admin`)
- `single_worker`: visit `https://<worker-name>.workers.dev` (admin at `/admin`)

### Test the API

```bash
# Public API (single_worker: use the same host as the status page)
curl https://<worker-url>/api/v1/public/status

# Admin API
curl https://<worker-url>/api/v1/admin/monitors \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>"
```

### Verify the Database (Optional)

Use Wrangler to check that key tables exist in D1:

```
monitors, monitor_state, check_results, outages, settings
```

## Troubleshooting

### "Resolve Cloudflare Account ID" fails

- Verify `CLOUDFLARE_API_TOKEN` is set and valid
- Confirm the token has account read permissions
- Set `CLOUDFLARE_ACCOUNT_ID` explicitly to skip auto-resolution

### D1 migration fails

- Check that `UPTIMER_D1_BINDING` matches the binding in `apps/worker/wrangler.toml`
- Verify migration SQL is idempotent and syntactically correct

### Static assets or SPA routes return 404 (`single_worker` mode)

- Confirm the `Build Web (Vite, single_worker)` step produced `apps/web/dist` before `Deploy Worker`
- Confirm the CI-generated `wrangler.ci.toml` still has the `[assets]` block (CI injects it when `UPTIMER_DEPLOY_MODE=single_worker`)
- Deep links like `/admin` rely on SPA fallback; in local dev use the Vite server on `:5173`

### Status page loads but API calls fail (`pages` mode)

- Confirm the Pages project exists and `Deploy Pages` ran after the Worker deploy
- Check that Pages secret `UPTIMER_API_ORIGIN` points at the Worker origin (workflow sets this best-effort)
- Confirm `apps/web/public/_worker.js` is present in the built Pages output (Vite copies `public/`)

### Admin returns 401

- Confirm `UPTIMER_ADMIN_TOKEN` was written to the Worker Secret
- Check that the token in the browser's localStorage matches the secret

## Rollback

Prefer redeploying the last known-good commit:

1. Find the last green deployment commit
2. Re-trigger "Deploy to Cloudflare" from that commit
3. If schema changes are involved, add a new forward-compatible migration rather than rolling back

> D1 migrations should not be rolled back destructively. If a remote migration was already applied, fix forward with a new migration.

## Relationship to CI

| Workflow     | Purpose                             |
| ------------ | ----------------------------------- |
| `ci.yml`     | Quality gate: lint, typecheck, test |
| `deploy.yml` | Production release                  |

Recommended branch strategy:

- PRs must pass CI before merging
- `master`/`main` only receives reviewed changes
- Releases are triggered automatically on push — no manual drift
