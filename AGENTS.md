# AGENTS.md: Working Agreement for Uptimer

Guidelines for code assistants and automation agents working in this repository.

---

## 1. Required Reading

Before making any changes (code, config, or destructive commands), read and understand:

- `AGENTS.md` (this file)
- `Develop/Application.md` (product specification & technical constraints)
- `Develop/Structure.md` (directory structure & module boundaries)
- `Develop/Plan.md` (milestones & acceptance criteria)
- `Develop/API-Reference.md` (Cloudflare / D1 / outbound API reference)
- `Develop/Local-Development-Experience.md` (local-only, gitignored; required when present; contains operational notes such as token locations, `.env` usage, Tail/Trace sample-rate rules, and Dev/Production workflow caveats)

If documentation conflicts with the current task, stop and align before proceeding. Never copy secret values from the local-only experience document into tracked files, chat, logs, PRs, or issues.

---

## 2. Technology Stack (Locked)

Do not introduce alternative technologies without explicit approval.

- **Frontend (Pages)**: React + Vite + TypeScript + Tailwind + React Router + TanStack Query + Recharts
- **Backend (Workers)**: TypeScript + Hono + Zod
- **Database**: Cloudflare D1 + Drizzle ORM; migrations via Wrangler D1 (SQL)
- **Auth**: Admin Bearer Token (stored in Workers Secret)

Any new dependency or service (Queues, DO, R2, etc.) requires a written justification covering: why it's necessary, why alternatives don't work, and the impact scope.

---

## 3. Repository Rules

- **Do not modify** the read-only reference project directory.
- Dual-repo default: `origin` is Main Repo, `dev` is Dev Repo. Main Repo writes (`push`, PR merge, issue comment/close, release edits) and production Cloudflare writes require explicit user authorization. Never push directly to `origin/master`; Main releases must go through PR.
- All external APIs must follow `Develop/Application.md` conventions (paths, time fields, error format).
- All input must be validated with Zod at runtime — never trust client or DB JSON fields.
- All DB writes must use parameterized queries (Drizzle or D1 prepared statements). No SQL concatenation.
- HTTP monitoring probes must explicitly disable caching (`no-store` + `cf.cacheTtlByStatus`).

---

## 4. Implementation Priority

Follow `Develop/Plan.md` strictly from Phase 0 through Phase 7:

- Worker + D1 must be functional (including scheduled triggers) before building full UI.
- HTTP/TCP monitoring and state machine correctness come before multi-region or advanced analytics.

---

## 5. Definition of Done

Every change must:

- Be small and focused (no "big bang" changes).
- Pass local checks (if scripts exist):
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` (if established)
- Include a new migration for any D1 schema change (never modify existing migrations).
- Include minimal tests or reproducible steps for behavioral changes.

---

## 6. Security Baseline

- Monitor targets are controlled SSRF: restrict protocols, deny private/reserved IP ranges by default. Port range 1-65535 is allowed. See `Develop/Application.md` for specifics.
- Admin Token goes only in Workers Secrets or `.dev.vars` (local). Never in Git, D1, or frontend code.
- Cloudflare API credentials for local Dev operations are stored in `.env` (gitignored). Load them only for required Wrangler commands; never print, commit, copy into docs, or expose token values in tool output.
- Local operational notes belong in `Develop/Local-Development-Experience.md` (gitignored) and must record only paths/procedures, never actual secret values.
- Webhook signing secrets must reference Worker secrets — never store in the database.

---

## 7. Change Description Format

When reporting changes, include:

- **What** you did (1-3 lines)
- **Why** (key constraints / risks)
- **Where** (affected file paths / modules)
- **How to verify** (commands or steps)
