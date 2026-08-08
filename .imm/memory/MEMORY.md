# MEMORY.md - Immune-Brain Memory Index

## Current Status
- Latest summary: Status-page custom logo plan (U1–U2) fully closed, QA-passed, code/UI-reviewed, Chrome HITL-verified. Header logo layout adjusted to horizontal row (logo left + title/description right). Known pre-existing bug: editing a status page with zero linked monitors fails 400/500 (form sends `monitor_ids: []` vs `idListSchema` `min(1)`).
- Todo: production deployment of migration `0018_status_page_logo_url.sql`; known pre-existing bug: editing a status page with zero linked monitors (e.g. `default`) fails 400/500 because the form sends `monitor_ids: []` while `idListSchema` requires `min(1)`.
- Last sync: 2026-07-13

## Task History
- 2026-07-13: Status-page custom logo plan executed across 2 steps (U1 Worker contract, U2 Web rendering). All steps closed, QA passed ×2, imm-code-review + imm-ui-review gates passed. Reusable wiring checklist + Zod default-field generic pitfall captured in solutions.
- 2026-07-13: Private status-page admin access plan executed across 2 steps (U1–U2). All steps closed, code/UI review gates passed, Chrome HITL verification completed. Follow-ups fixed analytics private error-cache headers, page-scoped analytics cache-key poisoning, and loading/login accessibility semantics.
- 2026-07-12: Status-page-custom-domains plan executed across 3 steps (U1–U3). All steps closed, code review gate passed, Chrome HITL verification completed.
- 2026-07-10 to 2026-07-11: Multi-public-status-pages plan executed across 6 steps (U1–U6). All steps closed, code review and UI review gates passed.

## Knowledge Index
- [Multi-Status-Page Cache Isolation](../solutions/multi-status-page-cache-isolation.md) — page-qualified key factory, dirty-page refresh queue, frontend slug propagation, custom-domain Host routing, and Admin-only private-page access with 404 concealment. reusability: high.
- [Adding a per-page public branding field end-to-end](../solutions/adding-per-page-public-branding-field.md) — complete wiring checklist (migration → resolver → CRUD → payload/stored schemas → fast guard → React → fixtures) and the Zod `.default()` + `z.ZodType<T>` generic input/output inference pitfall. reusability: high.
