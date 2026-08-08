---
title: "Adding a per-page public branding field end-to-end"
reusability: high
next_reuse_scenarios:
  - "Adding another per-status-page public field (e.g. favicon, theme color, custom CSS URL) to status_pages"
  - "Adding any additive nullable column to an existing D1 table that flows into public payloads"
  - "Extending Zod object schemas that contain default() fields and are passed through generic helpers"
key_files:
  - apps/worker/src/public/status-page.ts
  - apps/worker/src/schemas/status-pages.ts
  - apps/worker/src/routes/admin-status-pages.ts
  - apps/worker/src/schemas/public-status.ts
  - apps/worker/src/schemas/public-homepage.ts
  - apps/worker/src/public/status-refresh.ts
  - apps/worker/src/public/homepage.ts
  - apps/worker/src/public/homepage-guard-state.ts
  - apps/web/src/pages/StatusPage.tsx
  - apps/web/src/components/StatusPageForm.tsx
  - apps/web/src/i18n/messages.ts
---

# Adding a per-page public branding field end-to-end

## Reusable premise

The status-page branding pipeline (title/description, now `logo_url`) owns a
fixed wiring pattern. Adding a new per-page public field must touch every link
in this chain, or the field silently fails on one path (usually the scheduled
refresh fast path). The checklist below is the complete contract surface,
validated by the custom-logo feature (spec
`docs/specs/status-page-custom-logo.spec.md`, plan
`docs/plans/2026-07-12-status-page-custom-logo-plan.md`).

## The wiring checklist

1. **Migration** — new append-only file: `ALTER TABLE status_pages ADD COLUMN <field> TEXT;` (nullable, no backfill). Never edit applied migrations.
2. **Resolver** — `apps/worker/src/public/status-page.ts`: add the column to `PublicStatusPage` type and to **every** SELECT in the file (slug, accessible, by-id ×2, by-hostname — 5 queries; a missed one fails only on that route).
3. **Admin input schema** — `apps/worker/src/schemas/status-pages.ts`: `z.union([z.string(), z.null()]).optional().default(null)` + a normalizer mirroring `parseCustomHostnameInput` (`''`/`null`/`undefined` → `null`, else validate; return `null` for invalid and let the route throw `400 INVALID_ARGUMENT`).
4. **Admin CRUD** — `apps/worker/src/routes/admin-status-pages.ts`: `StatusPageRow`, list/INSERT/UPDATE/RETURNING column lists, `toApi`. PATCH semantics: omitted = unchanged, explicit `null`/`''` = clear.
5. **Payload schemas** — `apps/worker/src/schemas/public-status.ts` + `public-homepage.ts`: add to BOTH the runtime schema (`z.string().nullable().default(null)`) and the **stored** schema. Stored schema must use `.default(null)` (not bare `.nullable()`) so pre-deploy snapshots without the key still parse and render the safe default instead of failing → the field is backward compatible without a guard-version bump.
6. **Payload builders** — `apps/worker/src/public/status.ts` (`computePublicStatusPayload`), `apps/worker/src/public/homepage.ts` (all three builders: `homepageFromStatusPayload`, `computePublicHomepagePayload`, `computePublicHomepageArtifactPayload`, and the settings-promise merges), `apps/web/src/main.tsx` (`homepageFromStatus` local cache adapter).
7. **Scheduled fast guard** — `status-refresh.ts` and `homepage.ts`: add the column as a subselect (`<field>_value`), a normalizer (return `null` when invalid/oversized), and the equality comparison in `hasMatching*PublicSettings`. Without this, editing only the new field does NOT republish snapshots until unrelated churn. `homepage-guard-state.ts` cached-state schema + type need the field too (settings JSON is round-tripped through Zod).
8. **React** — header render with `alt=""`, `referrerPolicy="no-referrer"`, fixed size + `object-contain`, `onError` → `display:none` fallback; form field with empty-string → `null` mapping; 5-locale i18n labels (`en`/`zh-CN`/`zh-TW`/`ja`/`es`) each inside its locale const block.
9. **Fixture sweep** — every test `samplePayload` / guard mock row / envelope fragment fixture must gain the field (`null`), because stored-schema parsing now produces the key and `toMatchObject`/`deep equal` assertions fail on the extra key. Grep for the sibling `site_title` lines across `apps/worker/test/` and `apps/web/src` (e.g. `main.tsx`).

## Zod default-field generic pitfall (reusable, repo-agnostic)

`z.ZodType<T>` means `ZodType<T, ZodTypeDef, T>` — input == output. A schema
field declared with `.default(null)` has **input type including `undefined`**
but output `string | null`. Passing such a schema to a helper parameter typed
`z.ZodType<T>` makes TypeScript infer `T` from the *input* side, so the inferred
payload type turns the field optional (`logo_url?: ... | undefined`), breaking
assignability to the exact `z.infer` type. Fix: type the helper parameter as
`z.ZodType<T, z.ZodTypeDef, unknown>` (relax input) so `T` is inferred from the
output. This bit `parseEnvelopeFragment` in
`apps/worker/src/snapshots/public-monitor-fragments.ts` and cost a debugging
round; it will recur anywhere a Zod schema with defaults crosses a generic
helper.

## Evidence

- Custom-logo feature closed with 2 steps; QA pass ×2, imm-code-review pass, imm-ui-review pass.
- Worker: 65 files / 595 tests pass; focused logo suite 130 tests (migration shape, schema accept/reject/clear, Admin CRUD 400s, two-page isolation, fast-guard logo-only invalidation).
- `migrate:local` applied `0018_status_page_logo_url.sql`; stored schemas keep `.default(null)` and no guard-version bump was needed.
- Rejected during brainstorm: logo upload/base64/R2 (would require new-service justification; external URL only, Worker never fetches → zero SSRF surface).

## Reusability critique notes

- Falsifiability: the checklist is falsifiable — miss any numbered link and the feature fails on that path (fast guard was the historically missed one; the guard-version-vs-default decision is observable in stored-schema parse behavior).
- Evidence trail: every item above maps to a committed source file or passing test from the custom-logo plan; the Zod pitfall was reproduced via a standalone tsc probe before the fix.
- Architecture entropy resistance: appended to the existing branding-ownership chain (title/description) rather than a parallel mechanism; no new hub file created because this is one coherent navigation target (`docs/solutions/` currently holds only cache-isolation, which is a different concern).
