# Performance and resource budget

The application keeps the public `/api/v1` contracts while reducing per-probe D1 writes and serving validated public snapshots. Samples use a legacy table, archived hour buckets and an atomic current-hour buffer. REST readers combine these sources; direct database integrations must review the new schema and synthetic row identities.

`UPTIMER_RUNTIME_PROFILE=free` uses a SQLite Durable Object coordinator to keep ordinary Worker invocations short. `paid` uses Workers and D1 without a coordinator binding. Paid CPU allowance does not remove outbound connection, wall-clock, query, storage or billing limits. Hosting (`pages` or `single_worker`) is a separate choice.

Freshness is an explicit part of the UI: a quick cached render is followed by validation, stale/error states remain visible, and latency charts load on demand. Chart animation respects reduced-motion preferences. The release preparation changes deployment tooling and tests; it does not alter the frozen product implementation.

A fixed 24-hour staging window with 24 active one-minute monitors contained 34,560 canonical samples without gaps or duplicates, 55,310 D1 row writes and 3,388,147 row reads. Ordinary Worker CPU in that window was at most 7ms. These are measured results for that workload on a Paid account running the Free profile, not guarantees for every account or scale. Earlier CPU excursions remain part of the engineering record. Actual Free enforcement and historical 24-hour Pages CPU are not established by this window.

Local release checks additionally exercise 30 monitors with sparse IDs, seven days / 302,400 samples, failure and resume at every migration, and cold recovery through workerd, D1 and SQLite DO with synthetic network responses. This does not establish cloud-side DDL fencing, billing, real network behavior or Time Travel recovery.

See [deployment](../docs/deploy-github-actions.md), [upgrade and recovery](../docs/upgrade-and-recovery.md), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). A normal existing-instance upgrade with pending migrations remains blocked until a separately rehearsed maintenance procedure is approved.
