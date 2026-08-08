---
title: "feat: status-page-custom-logo"
type: feature
status: proposed
date: 2026-07-12
origin: "Confirmed imm-brainstorm framing: per-page external logo URL on public status pages"
---

# Iteration Plan

## Task

- Summary: Add an optional per-page external HTTPS logo URL that renders in the public status-page header, flowing through the existing branding ownership chain (`status_pages` → resolved page → public payloads → snapshots → React).
- Origin: User request "status page 支持自定义logo"; brainstorm confirmed option 1 (external URL only, no upload/R2) and favicon out of scope.
- Spec: docs/specs/status-page-custom-logo.spec.md
- Output Language: Human-readable prose is English. Schema fields, API routes, command lines, identifiers, and canonical terms remain literal.
- Brainstorm manifest: BR-REQ-1, BR-DEC-1, BR-DEC-2, BR-OUT-1, BR-OUT-2
- Research: Branding ownership already flows `status_pages.title`/`description` through `apps/worker/src/public/status-page.ts` resolvers into public status/homepage payload builders and scheduled fast-guard SQL subselects in `status-refresh.ts` (line ~640) and `homepage.ts` (line ~2190); snapshot freshness compares those values, and page edits already call `enqueueStatusPageRefreshes([id], now, 'page-updated')`. Admin status-page CRUD in `routes/admin-status-pages.ts` and `StatusPageForm.tsx` already demonstrate the exact pattern for adding a nullable per-page field (`custom_hostname`). React header in `StatusPage.tsx` renders text-only title/description today; public payload types live in `schemas/public-status.ts` and `apps/web/src/api/types.ts`. Adding `logo_url` is one more field along every one of these established paths.
- Decisions:
  - D1: New append-only migration adds nullable `status_pages.logo_url TEXT`; no backfill, existing rows stay logo-less.
  - D2: Logo is an external absolute `http(s)` URL ≤ 2048 chars, validated by parsing only; the Worker never fetches it. Empty string clears to `NULL`.
  - D3: `logo_url` is added to public status/homepage payload and stored snapshot schemas, and to the scheduled fast-guard comparison, so logo edits republish page-qualified snapshots even if the refresh queue row is lost.
  - D4: React header shows the image only when present, `alt=""`, `onError` hides it; absent or broken logo renders exactly today's text header.
  - D5: Favicon remains `/favicon.svg`; no upload/base64/R2 in this slice.
- Assumptions: Stored snapshot guard-version handling for a payload-shape change follows the existing pattern from migrations `0011`/`0012`; the executor will locate the exact guard constant during implementation. All existing resolver `SELECT`s in `status-page.ts` enumerate columns explicitly, so each must add `logo_url`.
- Scope Mode: Two-step vertical slice (Worker contract/storage first, Web rendering second)
- Engineering Closure Check:
  - architecture_surface: `apps/worker/migrations/`, Worker public/schemas/routes/snapshot guard paths, `apps/web/src/api/types.ts`, `apps/web/src/pages/StatusPage.tsx`, `apps/web/src/components/StatusPageForm.tsx`, `apps/web/src/i18n/messages.ts`
  - dependencies_known: yes; existing D1, Zod, snapshot refresh, React patterns are sufficient; no new dependency or service
  - verification_path: focused Worker vitest files (schema/migration, admin CRUD, public payload/snapshot tests), web lint/typecheck, full workspace tests, local migration, browser check of logo rendering and fallback
  - blockers: none
  - replan_condition: if stored snapshot schemas cannot accept the additive field without breaking in-flight snapshot compatibility beyond a guard-version bump, stop and return to planning with the concrete parse-failure evidence

## Brainstorm Trace

| Item | Status | Target | Reason |
| ---- | ------ | ------ | ------ |
| BR-REQ-1 | covered_by_step | U1, U2 | Per-page external logo URL stored, exposed publicly, and rendered. |
| BR-DEC-1 | captured_as_decision | D1/D2/D5 | External URL only; no upload/R2 (user-confirmed option 1). |
| BR-DEC-2 | out_of_scope | Spec Non-goals | User answered "1" to the direction question only; favicon customization was not requested and stays out. |
| BR-OUT-1 | out_of_scope | Spec Non-goals | Upload/base64/R2 storage deferred indefinitely; requires new-service justification. |
| BR-OUT-2 | out_of_scope | Spec Non-goals | Per-page theme, dark-mode logo variants, Admin-shell branding unchanged. |

## Devil's Advocate Audit

### Rollback resilience

- Migration is additive (`ADD COLUMN logo_url TEXT`); old code ignores the column, so rollback is a Worker/Web redeploy with no data restore. Applied migration is never edited.
- If the Worker step lands without the Web step, payloads carry an unused field; rendering is unchanged — no broken intermediate state.
- Stored snapshots written before the deploy lack `logo_url`; the guard-version bump treats them as stale and republishes rather than risking a shape mismatch.

### Verification vanity

- Admin CRUD tests must prove invalid URLs (non-http scheme, malformed, >2048 chars) are rejected with the existing 400, and that `''`/`null` clears the column — not merely that the happy path stores a string.
- Public payload tests must use two pages with different `logo_url` values to prove isolation, mirroring the existing `public-status-pages.test.ts` branding pattern; checking only the default page would miss cross-page snapshot leaks.
- Fast-guard verification must prove a logo-only edit (title/description unchanged) triggers republish; otherwise the guard comparison addition is unproven.
- Browser check must cover: logo present, logo absent (pixel-identical text header), and broken URL (image hidden, no layout break).

### Spec dilution detection

- Both payload families (status + homepage artifact) and both republish triggers (queue + fast guard) are included; narrowing to "React-only rendering" would violate the branding-ownership invariant from the prior spec.
- The fast-guard SQL change is required, not optional polish — without it, a logo edit on a page with otherwise-unchanged state would not republish snapshots until unrelated churn.
- Favicon and upload remain explicit non-goals rather than silently dropped scope.

## Steps

### Step 1

- Step ID: U1
- Result: Worker publishes per-page `logo_url` through the full storage-to-payload contract
- Verification: `pnpm --filter @uptimer/worker exec vitest run --config vitest.config.ts test/status-pages-schema.test.ts test/admin-status-pages.test.ts test/public-status-pages.test.ts test/public-ui-analytics.test.ts test/public-status.test.ts test/snapshots-public-status.test.ts test/snapshots-public-homepage.test.ts && pnpm --filter @uptimer/worker typecheck && pnpm --filter @uptimer/worker migrate:local` exits zero; focused tests prove migration shape, CRUD validation/clear semantics, payload isolation between two pages with different logos, and fast-guard republish on logo-only edits
- Test scenarios: migration adds nullable `logo_url` without touching other columns; create/patch accepts valid https URL; rejects non-http(s) scheme, malformed URL, and >2048 chars with 400; `''` and explicit `null` clear the value; omitted patch field leaves value unchanged; public status and homepage payloads expose resolved page's `logo_url`; two pages with different logos never cross through snapshots; logo-only edit invalidates snapshot via queue and fast guard
- Scope: `apps/worker/migrations/`, `apps/worker/src/`, `apps/worker/test/`
- Discovery cache: apps/worker/src/public/status-page.ts (all resolver SELECTs must add `logo_url`); apps/worker/src/schemas/status-pages.ts (input validation pattern mirrors `parseCustomHostnameInput`); apps/worker/src/routes/admin-status-pages.ts (CRUD + `toApi`); apps/worker/src/schemas/public-status.ts (payload + stored snapshot schemas); apps/worker/src/public/status-refresh.ts:640 (fast-guard branding subselects); apps/worker/src/public/homepage.ts:2190 (homepage fast guard); apps/worker/migrations/0017_status_page_custom_hostname.sql (most recent additive-column pattern)
- Execution note: test-first
- failure_behavior: Invalid logo input fails with existing `INVALID_ARGUMENT` 400; missing column on unmigrated D1 fails loudly at query time (never silently dropped branding); stale pre-deploy snapshots are republished via guard bump, not served with mismatched shape.
- security_considerations: URL is validated by parsing only and rendered as an `<img src>` in visitors' browsers; the Worker never fetches it, so no SSRF surface is added. Stored value is escaped by React/payload serialization like existing branding fields.
- Depends on: None

### Step 2

- Step ID: U2
- Result: Public status page header renders the admin-configured per-page logo with safe fallback
- Verification: `pnpm --filter @uptimer/web lint && pnpm --filter @uptimer/web typecheck && pnpm test` exits zero; local browser verification against the dev stack confirms logo renders in the header when set, header is pixel-equivalent to current text header when unset, a broken URL hides the image without layout break, and the Admin form creates/updates/clears the value with i18n labels in all locales
- Verification type: hitl
- Test scenarios: form field round-trips create/patch/clear; invalid URL surfaces the server 400 error; header shows `h-8 w-8 sm:h-10 sm:w-10 object-contain` image plus title when set; absent logo leaves DOM without an `<img>`; `onError` fallback hides broken images; `document.title` and description rendering unchanged; en/zh-CN/zh-TW/ja/es labels present
- Scope: `apps/web/src/`
- Discovery cache: apps/web/src/api/types.ts (StatusResponse/PublicHomepageResponse/StatusPage contracts); apps/web/src/pages/StatusPage.tsx:490 (header title/description block); apps/web/src/components/StatusPageForm.tsx:47 (customHostname field pattern to mirror); apps/web/src/i18n/messages.ts (`status_page_form.*` label group)
- failure_behavior: Broken or unreachable logo URL hides the image and keeps the text header; no fallback to another page's logo or a default brand asset.
- security_considerations: `referrerPolicy="no-referrer"` on the image avoids leaking page URL to third-party logo hosts; `alt=""` keeps the decorative image accessible.
- Depends on: U1
