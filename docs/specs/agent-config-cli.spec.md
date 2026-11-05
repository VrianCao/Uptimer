# Agent configuration CLI

**Design risk**: High — a new shell client crosses the Admin API credential boundary and exposes configuration mutations.
**Output language**: English.

## Outcome and boundary

Deliver one usable repository-local TypeScript CLI for shell-capable coding agents to manage monitors, notification channels, status pages, and global settings through the existing Admin API. Keep this as one Slice, `agent-config-cli`: one client, one authorization boundary, one rollback. No backend, database, UI, or production deployment changes are required.

## Discovery evidence

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`: Node >=22.14, pnpm 10, TypeScript, workspace globs, recursive checks; there is no CLI package yet.
- `apps/worker/src/routes/admin.ts`: authenticated monitor and notification-channel CRUD, monitor pause/resume and group operations, and separate GET/PUT uptime-rating settings. Monitor/channel lists accept limit 1–200 (default 50), without a cursor. Do not invent pagination or claim a complete inventory.
- `apps/worker/src/routes/admin-settings.ts`, `apps/worker/src/settings.ts`, `apps/worker/src/schemas/settings.ts`: global GET/PATCH and server-owned validation/refresh.
- `apps/worker/src/routes/admin-status-pages.ts`, `apps/worker/src/schemas/status-pages.ts`: CRUD, monitor membership, branding/custom hostname, conflict behavior, empty membership arrays and nullable fields. Delete can return 409 for linked resources; do not bypass it.
- `apps/worker/src/middleware/auth.ts`, `apps/worker/src/middleware/errors.ts`: full Admin Token authority and JSON API errors.
- `apps/worker/src/schemas/monitors.ts`, `apps/worker/src/schemas/notification-channels.ts`: existing validation depends on Worker/DB modules. Do not import Worker internals into the Node client or duplicate the complete business schema.
- `apps/web/src/api/client.ts`: existing caller maps methods, paths and JSON bodies, but owns browser authentication; do not reuse browser state in the CLI.
- `apps/worker/test/admin-status-pages.test.ts`, `apps/worker/test/admin-notification-telegram.test.ts`, `apps/worker/test/admin-settings-homepage-refresh.test.ts`, `apps/worker/test/admin-router-errors.test.ts`: existing server behavioral seams. New client tests exercise the CLI boundary; existing server tests remain unchanged.
- `CONTEXT.md` architecture pointers cover page isolation, not CLI discovery. Legacy memory has no CLI discovery cache. Local operational experience file is absent.

## Decisions and provenance

Each decision has exactly one source.

| Decision | Source | Contract |
| --- | --- | --- |
| D1 | BR-REQ-01 | Ship a shell-callable CLI with repository-local usage instructions. |
| D2 | BR-REQ-02 | Cover all four resource families and the operation matrix below. |
| D3 | BR-DEC-01 | Call existing authenticated Admin endpoints; the Worker owns business validation, storage, conflicts and refresh. |
| D4 | BR-DEC-02 | Discoverable help, JSON results, noninteractive invocation and distinct failure exit codes. |
| D5 | Delegated technical choice | Add `apps/cli` as private workspace package `@uptimer/cli`; run erasable TypeScript through Node `--experimental-strip-types`, including on the repository minimum Node 22.14. No compilation prerequisite or new CLI framework. |
| D6 | Delegated technical choice | Read `UPTIMER_URL` (instance origin) and `UPTIMER_ADMIN_TOKEN` from the process environment; no stored login/profile, token argument, automatic dotenv loading, or credential writes. |
| D7 | Delegated technical choice | Use `--file <path>` or `--file -` for UTF-8 JSON object payloads. Preserve field names, false, zero, empty arrays, explicit null and omission; never perform read/merge/write. |
| D8 | Delegated technical choice | Validate CLI arguments, environment, JSON object shape and response envelopes with the existing Zod version. Declare Zod as a direct workspace-package dependency, reusing the existing lockfile version. This is necessary under repository runtime-validation rules; native checks alone violate that rule. No new third-party library or service. |
| D9 | Delegated technical choice | Reject redirects, use a 30-second deadline covering fetch and body read, and never retry a mutation automatically. A timeout can mean an unknown write outcome; tell the caller to query before retrying. |
| D10 | Delegated technical choice | Redact credentials at the output boundary as specified below; errors never dump request bodies, raw response bodies or transport exception text. |
| D11 | BR-OUT-01 | MCP is out of this delivery. |
| D12 | BR-OUT-02 | Incident/maintenance management and Cloudflare deployment, Secrets and DNS operations are out. Editing a status page's existing custom_hostname remains in scope. |
| D13 | BR-OUT-03 | Declarative sync, diff/apply and cross-instance migration are out. |

## Technical Design

**Design views**: component interfaces, data flow, temporal sequence.

### Command interface

Canonical local entry: `pnpm --filter @uptimer/cli start --help`; package start invokes `node --experimental-strip-types src/index.ts`. Document `pnpm --silent --filter @uptimer/cli start ...` for JSON consumers and the direct Node invocation when absolute control of stdout is needed. npm publication/global installation is not a prerequisite for this repository delivery.

| Resource | Commands | Existing endpoint suffix under `/api/v1/admin` |
| --- | --- | --- |
| `monitors` | `list [--limit N]`, `create --file F`, `update ID --file F`, `delete ID`, `pause ID`, `resume ID` | `/monitors`, `/monitors/:id`, `/monitors/:id/pause`, `/monitors/:id/resume` |
| `monitors groups` | `reorder --file F`, `assign --file F` | POST `/monitors/groups/reorder`, POST `/monitors/groups/assign` |
| `notification-channels` | `list [--limit N]`, `create --file F`, `update ID --file F`, `delete ID` | `/notification-channels`, `/notification-channels/:id` |
| `status-pages` | `list`, `create --file F`, `update ID --file F`, `delete ID` | `/status-pages`, `/status-pages/:id` |
| `settings` | `get`, `update --file F` | GET/PATCH `/settings` |
| `settings uptime-rating` | `get`, `update --file F` | GET/PUT `/settings/uptime-rating` |

Create uses POST, update PATCH and delete DELETE unless specified. IDs are positive safe integers. Limits are integers 1–200; use server default 50 if omitted. No fabricated per-ID GET, cursor, list-all claim or configuration export. Help explicitly states the list limit. Manual monitor probes and channel test sends are diagnostics, outside the configuration command matrix.

Top-level and resource help run without credentials or requests and explain required inputs, supported operations, payload examples, list bounds and errors. Payload examples cover HTTP/TCP monitors, webhook/Telegram channels, status-page membership/branding, general settings and uptime-rating. Unknown commands/options, extra positionals and conflicting body sources fail before any request.

### Data flow and ownership

`index.ts` owns process arguments, file/stdin reading and exit status. A small exported `run` function accepts argv, environment, I/O and fetch dependencies for deterministic tests. Keep parsing, command mapping and HTTP handling in the fewest readable modules; no generic plugin architecture or SDK extraction.

Validate environment and command input first, then parse a JSON object with Zod and pass it to one known endpoint. The server remains authoritative for resource field validation; the CLI does not silently strip unknown payload fields. Use Node native `parseArgs`, `fetch`, URL and AbortController with existing Zod. Validate the expected top-level response envelope before reporting success; permit resource fields to evolve without duplicating server schemas.

On success print one JSON value plus newline to stdout and exit 0. Human help is the only non-JSON successful output. On error leave stdout empty and emit one JSON error envelope to stderr: `{ "error": { "code": "...", "message": "...", "status": 400 } }`, omitting status for local failures. Exit 2 for usage/configuration/input failures; exit 1 for HTTP, transport, deadline or response-contract failures. Preserve validated API error code and status while sanitizing the message. Never print a stack trace by default.

Credential output policy: never echo the supplied Admin Token anywhere, including a malicious response. Recursively redact keys `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `bot_token`, `bot_token_encrypted`, `password`, `token`, `secret`, `api_key` (case-insensitive). Redact complete `http_headers`, `http_body` and notification `config.headers`, `config.url`, `config.payload_template` values because they may embed credentials. Preserve secret-reference names and server redacted indicators. Replace exact occurrences of the supplied Admin Token in remaining strings. Document that output is a redacted management view, not a round-trippable backup; returned ordinary configuration still belongs to the administrator and should not be published.

### Transport sequence and recovery

1. Parse/help; reject invalid commands without reading credentials or contacting a server.
2. Validate origin and token. Allow HTTPS; allow HTTP only for explicit localhost, 127.0.0.1 or [::1] development origins. Reject URL userinfo, query, fragment, non-root path and other schemes. Append the fixed API prefix, never accept an arbitrary request path.
3. Read and validate the optional body, preserving PATCH semantics. Send one authenticated request with redirects disabled.
4. Keep the deadline active through response-body consumption. Reject redirects, non-JSON and wrong-envelope success responses. Cancel unfinished response bodies and clear timers on every terminal path.
5. Render sanitized JSON or an explicit failure; no automatic retry, rollback or conflict bypass. A caller interruption or timeout after sending a write has an uncertain result; subsequent queries are the recovery mechanism.

Threat model and supported environment: CLI arguments, files/stdin and HTTP responses are untrusted; a misconfigured or hostile endpoint can return credential-bearing errors or redirects. The administrator intentionally selects a trusted API origin and supplies its full-privilege token. Protect transport and output without introducing RBAC. Support Node >=22.14 on macOS/Linux, UTF-8 JSON, and ordinary repository Git SHA-1/SHA-256 identities (CLI logic does not inspect Git objects). Shell/OS compromise and arbitrary secrets encoded inside unrelated free-text fields are outside the output-redaction guarantee. Automated acceptance uses injected fetch, never production or internet access.

## User scenarios

### BR-SCN-01

- **Actor:** A coding agent with shell access.
- **Given:** An Uptimer instance URL and a valid Admin Token are available.
- **When:** The agent queries configuration and performs a supported configuration change through the CLI.
- **Then:** The agent receives structured JSON results, and a subsequent query shows the saved change.

Automated: A2, using a stateful injected API fake at the real command runner seam. This proves client round-trip behavior; existing server tests establish persistence/refresh behavior. It is not a claim of live deployment verification.

## Acceptance and Verification

Every acceptance has exactly one source. New tests use native `node:test` and `node:assert`, execute actual CLI parsing/request/output code and fail on zero executed cases. The native Node executable is supplied by the host; test files and CLI are delivered in this task. Zod comes from the existing pnpm dependency version installed in `node_modules`; implementation updates the workspace lockfile and installs normal workspace dependencies before QA. No package installation, build, outbound network, credentials or production preparation is hidden inside descriptors. Type stripping runs source directly. Tests use injected fetch and temporary file fixtures with cleanup in finally/after hooks, including failure paths.

| ID | Exactly one source | Observable invariant and controls | Agreed focused seam |
| --- | --- | --- | --- |
| A1 | BR-DEC-02 | Real process entry provides help without credentials, exits 0, documents all command families and required body format; invalid command, extra positional, unknown option and missing body exit 2 with empty stdout and structured stderr. Boundary: list limit 1/200 accepted, 0/201 rejected; ID 0, negative, fractional and unsafe integers rejected before fetch. | `apps/cli/test/entry.test.ts`; spawn the actual Node entry for help/local failures, run argument-bound tests through run. |
| A2 | BR-REQ-02 | Every operation in the command matrix calls the correct method/path once and returns the API result; one stateful create/update/list/delete round trip per CRUD family and get/update/get for both settings routes. Cover pause/resume and group commands. Preserve null, false, zero, [], and omitted fields. Invalid JSON, array/scalar/null body and missing file fail locally without writes. List responses at 50/200 are explicitly bounded, never presented as a complete inventory. | `apps/cli/test/resources.test.ts`; run with stateful injected fetch and captured I/O, verify request bodies and observed readback. |
| A3 | Delegated technical choice (D6, D9, D10) | A valid HTTPS endpoint receives Bearer authentication; loopback HTTP works. Missing token/origin, URL userinfo/query/fragment/non-root path, ftp and remote HTTP fail before fetch. Redirect, 401, 403, 404, 409, 429, 500, non-JSON and wrong-envelope 200 produce exit 1 without success output. Fetch failure and a body that outlives the deadline terminate and release timers/body; mutation attempts remain exactly one. Admin Token echoed by a response and enumerated sensitive fields are redacted on both output paths. Ordinary fields and secret references remain readable. | `apps/cli/test/transport.test.ts`; injected fetch, Response/ReadableStream, deterministic short injected deadlines and captured output. |

Commands (one descriptor per row):

- A1: `node --experimental-strip-types --test apps/cli/test/entry.test.ts`
- A2: `node --experimental-strip-types --test apps/cli/test/resources.test.ts`
- A3: `node --experimental-strip-types --test apps/cli/test/transport.test.ts`

Each descriptor uses cwd `.`, timeout 30000 ms, maximum output 32768 bytes, no prepare command and no generated directory requirement. Runtime warnings on stderr from experimental Node features are host diagnostics; application stderr error assertions inspect the application JSON and ensure stdout remains clean.

Implementation also runs repository-required `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `git diff --check` after wiring the new workspace scripts. These broader checks are completion evidence, not acceptance descriptors. Verify the documented local invocation and run focused tests on Node 22.14 when available; current planning host is Node 24.18. No live instance test is required for this client-only change.

## Compatibility, rollback and Devil's Advocate Audit

- No server behavior or schema changes; old clients continue working. An API conflict remains an error, not permission to mutate related entities. No compatibility bridge is introduced.
- Rollback removes the new package, its dependency lock entry, eslint Node scope and documentation changes. Partial local implementation cannot change production configuration unless someone explicitly runs a mutation command against that instance.
- Verification vanity: tests assert command requests, returned state, output and exit codes, not source-code string presence. Stateful fakes must include negative responses and input rejection, and cannot prove a deployed server's health. Existing server seams remain authoritative for D1 writes and cache refresh.
- Scope dilution: all four resource families, both global-settings routes, help and failure behavior belong to the same Slice. A CLI scaffold or monitor-only prototype does not satisfy A2. No migration, MCP adapter or Cloudflare provisioning is concealed as a follow-up requirement.
- Credential boundary: a full Admin Token cannot be made read-only by client code. Redaction prevents documented output leaks, not administrator misuse. Disable redirects and avoid mutation retries to contain concrete client risks.

## Brainstorm Trace and handoff completeness

Each upstream item is mapped exactly once here.

| Upstream item | Disposition | Owner |
| --- | --- | --- |
| BR-REQ-01 | covered | D1: shell-capable agent entry |
| BR-REQ-02 | covered | A2: complete resource operation matrix |
| BR-DEC-01 | decisioned | D3: existing Admin API ownership |
| BR-DEC-02 | covered | A1: help/JSON/error interface |
| BR-OUT-01 | out | D11: no MCP |
| BR-OUT-02 | out | D12: application configuration only |
| BR-OUT-03 | out | D13: no declarative sync/migration |
| BR-SCN-01 | covered | User scenarios, automated by A2 |

Required delivery phases: CLI entry/discovery (A1), complete configuration operations and readback (A2), credential/error handling (A3), usage documentation and workspace check integration (D1/D5 and completion checks). All belong to Slice `agent-config-cli`. Its closable result is a usable local CLI covering the full confirmed scope. Remaining confirmed-outcome gap after the Slice: none. npm publication, live production verification and excluded product features are not implied deliverables. There are no unresolved user-owned decisions.
