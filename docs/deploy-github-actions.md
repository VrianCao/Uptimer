# Deploy with GitHub Actions

English | [中文](deploy-github-actions.zh-CN.md)

The release workflow builds and reviews a package **before any cloud write**. A separate manual apply deploys that exact package. Ordinary branch pushes run CI and do not deploy. The default remains **Workers + Pages**; `single_worker` uses **Workers + Workers Assets**.

## Current supported boundary

- New empty installation: explicitly choose `install` with unused resource names (an already existing empty D1 requires `upgrade` and its exact UUID); create the named D1 database, apply migrations, initialize a missing admin secret, deploy Worker and frontend.
- Existing installation: choose `upgrade` and supply the exact existing D1 ID. No replacement database is created. A matching deployment package is a no-op on repeat; a Pages failure can resume after the Worker succeeded.
- **Existing Worker with pending D1 migrations: plan only, apply blocked.** The legacy storage transition changes the physical sample layout. It needs a separately rehearsed maintenance and compatible forward-recovery procedure. No switch bypasses this block.
- Hosting/profile changes are separate operations. Keep the deployed hosting and runtime profile for an upgrade. A runtime profile change appears as a blocking plan; hosting changes fail planning. See [upgrade and recovery](upgrade-and-recovery.md).

The Dev repository keeps a guarded diagnostic caller in `deploy.yml`. The public-ready caller template is [examples/deploy.yml](examples/deploy.yml); do not copy Dev account guards or diagnostic workflows into a public fork. The shared implementation is `.github/workflows/release.yml` and `apps/worker/scripts/release*.mjs`.

## Configuration

Node and pnpm are pinned by `.node-version` and `packageManager`. The workflow installs the lockfile without updating dependencies. Python 3.11+ with standard-library `tomllib` is required (available on the GitHub Ubuntu runner).

| Secret                  | Purpose                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Scoped to the intended Cloudflare account: Workers Scripts Edit, D1 Edit, and Pages Edit for Pages hosting. Planning uses metadata reads and read-only D1 queries.                                                                             |
| `UPTIMER_ADMIN_TOKEN`   | Initialize `ADMIN_TOKEN` only if absent, and verify authenticated **read-only** Worker requests. Existing secrets are preserved, never routinely rotated. Keep this value aligned with the actual admin secret; a mismatch fails verification. |
| `CLOUDFLARE_ACCOUNT_ID` | Required exact account ID; a repository variable of the same name is also accepted. No first-account auto-selection.                                                                                                                           |
| `VITE_ADMIN_PATH`       | Optional custom admin path; repository variables `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` are also accepted.                                                                                                                                   |

| Repository variable                                               | Default / meaning                                                                                                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPTIMER_D1_ID`                                                   | **Required for upgrades**, exact existing database UUID. Names alone are insufficient.                                                                                              |
| `UPTIMER_PREFIX`                                                  | Lowercase repository name; stable naming fallback.                                                                                                                                  |
| `UPTIMER_WORKER_NAME`, `UPTIMER_D1_NAME`, `UPTIMER_PAGES_PROJECT` | Override individual names.                                                                                                                                                          |
| `UPTIMER_DEPLOY_MODE`                                             | `pages` (default) or `single_worker`.                                                                                                                                               |
| `UPTIMER_RUNTIME_PROFILE`                                         | `free` (default hybrid Worker + SQLite DO) or `paid` (Worker + D1, no coordinator binding). Independent of hosting. No subscription auto-detection.                                 |
| `UPTIMER_WORKER_URL`                                              | Optional exact HTTPS Worker origin, e.g. a custom Worker domain; otherwise resolve the account's workers.dev subdomain. Enable workers.dev or configure the domain before using it. |
| `UPTIMER_API_BASE`, `UPTIMER_API_ORIGIN`                          | Optional existing Pages API configuration. Default browser API is same-origin `/api/v1`; Pages proxies to the Worker. Explicit endpoint settings are retained.                      |

The application DB binding remains `DB`, and `SELF` points to the same Worker. Configure advanced runtime flags in the canonical `apps/worker/wrangler.toml`; the generated configuration is not a second source of truth. Ordinary deployment uses canonical vars and preserves existing secret bindings. Do not rely on untracked Dashboard-only plain vars.

The Free profile can use DO included allowances even on Paid accounts; select `paid` for the Worker/D1 execution path. Paid config uses 30,000ms CPU, but CPU allowance does not eliminate wall-clock, outbound connection, storage or account quotas. Dev's Free profile on its existing Paid account keeps a 30,000ms ceiling for DO operation; this is **not** proof of actual Free-plan enforcement. See [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) and the release evidence.

Both hosting modes use the frozen application implementation, including preload/freshness handling where supported. Choosing a hosting mode does not select a runtime profile. Pages API proxy calls consume Pages Functions/Workers allowance; `single_worker` avoids this extra proxy hop.

## GitHub setup

1. Add the secrets and variables above. Confirm names, account, D1 ID and API origin against the existing deployment.
2. Configure the **`cloudflare-release` Environment**: required reviewers, protected deployment branches/tags, and scoped deployment secrets if supported by your repository/plan. Restrict who can dispatch workflows and change secrets/variables. GitHub does not create reviewer protection just because YAML names an Environment. `cloudflare-plan` is the read-only planning Environment; it also needs read credentials if using Environment-only secrets.
3. Require CI checks in branch protection. A release also calls the same reusable CI itself: lint, typecheck, generated bindings, immutable migration history, unit/Cron tests and all four build configurations.
4. Review the public caller template before adopting it. Updating workflow files is a repository change; it does not deploy until a manual apply is requested.

An Environment gate is defense in depth. This project does not auto-configure repository policies, mint a least-privilege token, or infer authorization from a successful CI run. Only dispatch trusted source refs; workflows execute repository code with the provided secrets.

## Plan → review → apply

1. Freeze a source commit and choose that ref in **Actions → Deploy to Cloudflare**.
2. Run with `release_action=plan`, `operation=install|upgrade` (public caller), and the existing hosting mode (`auto` reads the repository variable). Dev is fixed to upgrade its existing resources.
3. Wait for CI and plan to succeed. Read the summary and download **`uptimer-release-package`**. Inspect `plan.json`: repository/source, exact account and names/UUID, hosting/profile, migration prefix and pending files, planned operations and blockers. Inspect `manifest.json` and its file hashes. A successful planning job can contain a **blocked plan**; it is not deployment approval.
4. Keep the source ref **unchanged**. Run `release_action=apply` on that same commit with `plan_run=<successful manual plan run ID>` and `plan_hash=<full SHA-256 from its summary>`. Keep operation, hosting, secrets/build inputs and variables unchanged. A later documentation commit also changes the source SHA and requires a new plan.
5. Apply validates run provenance, source, target/config/lockfile and every package file before writing. It downloads the reviewed artifact and runs Wrangler `--no-bundle`; it does not rebuild source after review. Cloud identity drift stops the run. The workflow serializes releases by installation across refs and does not cancel a running apply when another starts. Keep resource naming variables stable across queued runs.
6. It records final Worker version **after** any initial secret creation; Pages follows Worker. Receipts are uploaded even after partial failure. Public HTML/entry asset, public API, unauthenticated 401, internal 404, direct Worker admin read and two advancing public publications are verified. HTTP 200 with stale data fails. A new install may wait up to 15 minutes for the initial Cron registration/publication (retrying initial 502/503 only), then requires two advancing publications within 210 seconds; existing-site outages fail immediately. This smoke check does not replace browser QA, physical-device testing, 24-hour resource acceptance or Pages authenticated-proxy QA.

Packages expire after **30 days** and can be deleted earlier. Download and privately retain the reviewed package and receipt before release. Re-running the original plan job rebuilds/replans and may change its hash; it is not an apply retry. Download only artifacts from this repository's successful manual plan at the same source SHA; fork PR artifacts are rejected.

For a first install, record the allocated D1 UUID from the receipt and use it for subsequent `upgrade` plans. If first-install apply fails partway, resume the **same install plan** before changing variables; it resolves the same named empty installation and applies only the remaining migration prefix. After a matching Worker is deployed, its package fingerprint/DB binding also identifies the installation. An unrelated populated database appearing at that name is rejected.

For a successful repeated apply of the **same reviewed package**, migration/Worker/Pages/secret operations are skipped. Read-only identity and smoke requests still run. Different plans are serialized rather than atomically transacted across Cloudflare products. GitHub queue cancellation, runner failures and API timeouts can still interrupt a release; inspect the receipt and live identities before resuming.

## Troubleshooting and recovery

- Missing D1 ID/account, unknown/duplicate/non-prefix migration records, gradual deployment, undeployed Worker candidate, changed hosting or external deployment drift: stop and inventory, then generate a new plan. Do not delete tracker rows to force success. A known historical `0014_check_results_without_autoincrement.sql` tracker entry is retained and recognized explicitly.
- `blocked` existing migration/profile plan: follow [upgrade and recovery](upgrade-and-recovery.md). Do not call old automatic deploy scripts to bypass it.
- Worker succeeded / Pages failed: preserve D1 and Worker; resume the same reviewed package. No automatic rollback is attempted.
- Existing secret/token mismatch: reconcile credentials through an explicit secret rotation procedure. An ordinary retry must not overwrite a working admin key.
- Smoke failure: retain receipt and inspect live source/version/freshness. Do not declare success, expand rollout or automatically restore D1. A resumed no-op deployment will run smoke again.

Do not put a database export, admin key, webhook secret or recovery credential into a public artifact/Release. The package includes public application code, configuration and migrations; receipts contain identifiers/hashes, never secret values. Deployment changes application versions and first-install schema; it does not publish a GitHub Release or modify DNS/custom domains.
