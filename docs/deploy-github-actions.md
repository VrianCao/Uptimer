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

**Steps (in order)**:

1. Install Node + pnpm + dependencies
2. Resolve Cloudflare Account ID (reads from config, falls back to API query)
3. Compute resource names (Worker / Pages / D1)
4. Check or create D1 database, inject real `database_id` into temp `wrangler.ci.toml`
5. Run remote D1 migrations
6. Deploy Worker
7. (Optional) Write Worker Secret: `ADMIN_TOKEN`
8. Build and deploy Pages
9. (Optional) Write Pages Secret: `UPTIMER_API_ORIGIN`

## Configuration

### Required Secrets

| Name                   | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN` | Yes      | Cloudflare API authentication                                            |
| `UPTIMER_ADMIN_TOKEN`  | Yes      | Admin dashboard access key; auto-injected as Worker `ADMIN_TOKEN` secret |

### Recommended Secrets

| Name                    | Description                     |
| ----------------------- | ------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Avoids auto-resolution failures |

### Optional Variables

Override default naming and routing:

| Name                                     | Default                   | Description                                                                         |
| ---------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `UPTIMER_PREFIX`                         | Repository name slug      | Unified resource name prefix                                                        |
| `UPTIMER_WORKER_NAME`                    | `${UPTIMER_PREFIX}`       | Worker name                                                                         |
| `UPTIMER_PAGES_PROJECT`                  | `${UPTIMER_PREFIX}`       | Pages project name                                                                  |
| `UPTIMER_D1_NAME`                        | `${UPTIMER_PREFIX}`       | D1 database name                                                                    |
| `UPTIMER_D1_BINDING`                     | `DB`                      | D1 binding name in Worker                                                           |
| `UPTIMER_API_BASE`                       | Auto-derived or `/api/v1` | API address (e.g. `https://my-worker.example.com/api/v1` or `/api/v1`)              |
| `UPTIMER_API_ORIGIN`                     | Auto-derived              | API origin (e.g. `https://my-worker.example.com`); `/api/v1` appended automatically |
| `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` | —                         | Custom admin dashboard path                                                         |

> If no naming variables are set, the workflow uses the repository name slug as the default prefix. This keeps names stable across forks.
>
> **API address**: Usually no configuration needed — the workflow detects the Worker URL automatically. Set `UPTIMER_API_BASE` or `UPTIMER_API_ORIGIN` only if the API is on a custom domain. Both accept the same information in different formats; setting one is enough.

## Cloudflare Token Permissions

The workflow creates and updates multiple resources. Your token needs:

- Workers Scripts: deploy and manage secrets
- D1: query, create, and migrate databases
- Pages: create projects and deploy
- Account: read account info (for account ID resolution)

## First Deployment

1. Add `CLOUDFLARE_API_TOKEN` to repository secrets
2. Add `UPTIMER_ADMIN_TOKEN` (admin dashboard access key)
3. Add `CLOUDFLARE_ACCOUNT_ID` (recommended)
4. (Optional) Set `UPTIMER_PREFIX` to avoid name collisions
5. Push to `master`/`main`, or manually trigger "Deploy to Cloudflare"
6. Once the workflow succeeds, note the Worker URL and Pages URL from the logs

## Post-deployment Verification

### Check the Status Page

- Visit the Pages URL (public status page)
- Navigate to `/admin` (or your custom `VITE_ADMIN_PATH`)

### Test the API

```bash
# Public API
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

### Pages builds but API returns 404 or HTML

- Verify that `UPTIMER_API_BASE` or `UPTIMER_API_ORIGIN` points to your Worker, not to the Pages site
- "API returned HTML instead of JSON" usually means the URL is hitting Pages (which returns HTML) instead of the Worker
- If neither variable is set, the workflow uses the Worker URL automatically — check that it resolved correctly in the deploy logs

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
