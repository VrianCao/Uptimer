# Deploy Uptimer with GitHub Actions

English | [中文](deploy-github-actions.zh-CN.md)

Fork Uptimer on GitHub and enable workflows in your fork's **Actions** tab. Use **Sync fork** to receive updates. Start each deployment yourself under **Actions → Deploy to Cloudflare**.

## 1. Add two secrets

In your fork, open **Settings → Secrets and variables → Actions → New repository secret**.

| Secret                 | What to enter                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | In [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens), use the **Edit Cloudflare Workers** template, scope it to the deployment account, and add **D1 / Edit**. Default Pages hosting also needs **Cloudflare Pages / Edit**. |
| `UPTIMER_ADMIN_TOKEN`  | For a new site, generate a strong random key. For an upgrade, enter the existing admin key. Deployment preserves the Worker secret that is already configured.                                                                                     |

Workers + Pages is the default. To host the frontend and API on one Worker, set the repository variable `UPTIMER_DEPLOY_MODE=single_worker` before your first install. For upgrades, keep the current hosting mode and runtime profile. See the [configuration reference](configuration-reference.md) for custom names, domains, and admin paths.

## 2. Generate a plan

Go to **Actions → Deploy to Cloudflare → Run workflow**, choose the branch to deploy, and select `release_action=plan`. Choose `operation=install` for a new site or `upgrade` for an existing site. The workflow provisions resources on first install.

In the completed plan's **Summary**, check the account, Worker, database, Pages project if applicable, and pending migrations. The plan only reads cloud data. If it reports **BLOCKED**, follow the reason in the summary. Existing sites with pending D1 migrations need the [upgrade and recovery procedure](upgrade-and-recovery.md).

## 3. Apply and open the site

Run the workflow again at the same source commit with `release_action=apply`. Keep the same `operation` and hosting mode. Copy **Plan run ID** and **Plan SHA-256** from the plan summary into `plan_run` and `plan_hash`. Generate a new plan if the commit changes. Apply deploys the reviewed build.

Once deployment and verification pass, open your status page from the **Summary**, go to `/admin` (or your custom path), and sign in with `UPTIMER_ADMIN_TOKEN`.

## Troubleshooting

- **Cloudflare account could not be identified.** If the API cannot list accounts or returns multiple accounts, add the [`CLOUDFLARE_ACCOUNT_ID`](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/) repository variable and plan again. A single account returned by the API is used automatically.
- **Existing Worker could not be found.** Check your branch and `UPTIMER_WORKER_NAME`. The live Worker's `DB` binding identifies its database. If a first install created D1 before the Worker deployed, verify the database UUID against the receipt, set `UPTIMER_D1_ID`, and generate an `upgrade` plan.
- **Pages failed after Worker deployed, or verification failed.** Check the failed run's **`uptimer-release-receipt`** and follow [upgrade and recovery](upgrade-and-recovery.md). Plan artifacts are kept for 30 days. Teams can add reviewers to the **`cloudflare-release`** environment for an approval step after manually starting apply.
