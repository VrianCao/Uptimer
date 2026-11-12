# Runtime profiles

Choose a profile explicitly with repository variable `UPTIMER_RUNTIME_PROFILE`. The deployment workflow does not infer Workers subscription from another Cloudflare product or account metadata.

| Profile          | Execution                                                     | Intended subscription                                                 |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `free` (default) | Ordinary Worker + SQLite Durable Object coordinator + D1      | Workers Free; may also run on Paid, consuming applicable DO allowance |
| `paid`           | Worker + D1, no coordinator binding or project DO invocations | Workers Paid/Standard; configuration sets 30,000ms CPU                |

The canonical config is `apps/worker/wrangler.toml`; `configure-runtime-profile.mjs` derives the selected configuration. Both profiles retain the `SiteCoordinator` class export and its migration history, so changing runtime profile is not a request to delete Durable Object state. An unused class export does not itself invoke an object.

The coordinator is needed to move orchestration work out of ordinary Free invocations while retaining a single execution owner and atomic D1 samples. Keeping all orchestration in the Free Cron was constrained by the 10ms ordinary CPU budget; adding KV would not provide the same consistent coordination and would introduce another write quota. Paid avoids the coordinator through its separate Worker/D1 path. The impact is one site coordinator namespace/object; D1 remains canonical, and no Queues, KV or R2 service is introduced. Requests, duration and SQLite usage remain subject to the applicable DO allowance/pricing, including when the Free profile is selected on a Paid account.

Hosting is independent: default `pages` deploys the UI on Pages and the API on a Worker; `single_worker` uses Workers Assets. Pages same-origin API forwarding adds a Function/Workers invocation, while Workers Assets avoids that proxy hop. Preserve an existing installation's hosting for an ordinary upgrade.

Paid uses six independently delivered Cron expressions to coordinate work while respecting per-invocation connections. Free→Paid requires preparation and actual observation of Cron propagation under a compatible Free entrypoint. Paid→Free must account for in-flight scheduler overlap. The generic release workflow blocks profile changes; do not combine them with database migrations or bypass the gate by editing a single Dashboard variable.

Free is not a promise of unlimited monitors, traffic or zero account charges. DO included usage can be consumed on Paid accounts, D1 reads/writes include maintenance and user traffic, and account allowances may be shared with other applications. Consult [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

See [deployment](../docs/deploy-github-actions.md) and [upgrade/recovery boundaries](../docs/upgrade-and-recovery.md).
