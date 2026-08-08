# Project Context

Shared project vocabulary and navigation pointers live here.

## Architecture Map

- Public status-page identity and cache isolation: apps/worker/src/public/status-page.ts, apps/worker/src/snapshots/public-page-keys.ts, apps/worker/src/snapshots/status-page-refresh-queue.ts (Resolve page ownership and keep snapshots page-qualified.)
- Public branding flow: apps/worker/src/public/homepage.ts, apps/worker/src/public/status-refresh.ts, apps/web/public/_worker.js, apps/web/src/pages/StatusPage.tsx (Carry resolved page title/description/logo_url through snapshots, HTML metadata, and React. Full wiring checklist in docs/solutions/adding-per-page-public-branding-field.md.)
- Reusable status-page isolation guidance: docs/solutions/multi-status-page-cache-isolation.md (Read before adding page-scoped public fields or custom-domain routing.)
- Custom-domain routing contract: docs/specs/status-page-custom-domains.spec.md, apps/worker/src/public/status-page.ts, apps/web/public/_worker.js (Resolve validated Host ownership before cache/proxy access, then reuse the existing resolved page identity.)

## Language

- Term: Short definition.

## Relationships

- Term A relates to Term B through a concrete project behavior.

## Flagged ambiguities

- Ambiguous term: preferred meaning and when to ask for clarification.
