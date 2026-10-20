# MuleWatch codebase audit and redesign record

Date: 2026-10-21. Scope: everything under this folder except `node_modules`,
`.next` and Python caches. The folder is not a Git repository, so nothing was
committed. Superseded files were first kept in `_legacy_ui_backup/`, then
deleted at the owner's request on 2026-10-21.

## 1. Baseline (before any change)

| Check | Result |
| --- | --- |
| `npm run build` | **Failed.** `src/lib/supabase-admin.ts` threw at import time when env vars were absent, breaking "collect page data" for `/api/network`. |
| `npx tsc --noEmit` | 1 error: `LayoutProps` not found (generated route types missing before a build). |
| `npm run lint` | 6 errors: 3 × `react-hooks/set-state-in-effect`, 2 × unescaped `'`, 1 × `no-explicit-any` (test). |
| `npm test` (Vitest) | 46 / 46 passed. |
| `pytest api/tests` | 4 / 4 passed. |
| `npm audit` | 5 high, all in dev tooling (`braces`); 0 in production dependencies. |
| App start | Not possible against real data: no `frontend/.env.local` and no publishable key anywhere in the folder. |

## 2. What existed

**Working**
- Supabase email/password auth in the browser; bearer-token verification in
  each route handler.
- `/api/predict`: input validation, FastAPI call with 90 s timeout, response
  validation, idempotent upsert by `external_transaction_id`, alert creation.
- `/api/alerts` (GET, ≤100 unresolved), `/api/alerts/[id]` (PATCH status),
  `/api/network` (recursive-CTE RPC + path building),
  `/api/network/accounts/[id]/transactions` (paged history).
- FastAPI service: model loaded once at startup, strict Pydantic schema
  (`extra="forbid"`), feature order matching the trained pipeline (verified by
  loading the artefact: `feature_names_in_` = the eight columns in the same
  order), tuned threshold from JSON.
- Separation of model alerts from PaySim demonstration alerts in `/api/alerts`.

**Defects found**
1. Production build failed without env (above).
2. The prediction panel's **Retry** button called
   `document.querySelector("#mulewatch-prediction-form")`, but the form had no
   id, so Retry did nothing.
3. The single dashboard mixed a light-themed panel into a dark page and
   stacked three unrelated tools vertically.
4. Network graph re-ran `zoomToFit` after every expansion, discarding the
   analyst's zoom; stats were recomputed via `setState` in an effect.
5. Accounts touching a flagged transaction were labelled "Model-flagged" —
   association presented as a finding.
6. Token verification was copy-pasted into five routes with inconsistent
   fallbacks (`ANON_KEY` accepted in some, not others).
7. Public sign-up was always visible while any signed-in user could read all
   data.
8. Root `.env` and a duplicate `env` file contain Supabase secrets, and the only
   `.gitignore` was inside `frontend/`, so a `git init` at the root would have
   committed them.
9. `next/font/google` makes `next dev` depend on reaching Google Fonts; in this
   environment that timed out and the dev server returned 500.
10. `/supabase-test` debug page ("DAY 10") shipped as a public route.

**Found during verification and fixed**
11. When Supabase Auth was unreachable, `supabase-js` returned (not threw) an
    `AuthRetryableFetchError`; routes answered 401 and the client signed the
    analyst out during an outage. Now 503 and the session is kept.

**Not verifiable here**
- The SQL of `get_mulewatch_two_hop_transactions`, table DDL, indexes and RLS
  policies are not in the repository.
- The deployed Render service and real Supabase project (no credentials were
  used; the secret key in root `.env` was deliberately not wired into the app).

## 3. Design decisions

- **Light, paper-toned workspace.** The core work is reading dense tables and
  IDs for long periods; a warm off-white canvas with white panels keeps contrast
  high without glare, and the graph canvas stays legible without glow effects.
- **Colour roles never overlap.** Ink-blue is only for actions and selection;
  red/orange/amber/green only for model severity; violet only for PaySim
  ground truth. Every coloured state is also text, and severity carries a bar
  count, status an icon, flagged-association a diamond shape, PaySim
  association a dashed ring.
- **IBM Plex Sans / Mono**, vendored (SIL OFL) and loaded with
  `next/font/local`: tabular figures for amounts, mono only for identifiers.
- **Top navigation with three destinations** (Alerts, Network, Evaluate)
  instead of a sidebar or KPI dashboard: there are three workflows, and no
  endpoint provides honest aggregate counts for an overview.
- **Drawer for alert review** (native `<dialog>`: focus trap, Escape, focus
  return), with resolve behind a confirmation because it removes the alert from
  the queue.
- **No new dependencies.** Primitives are a single `components/ui.tsx`.

## 4. Changes

**Server**
- `lib/supabase-admin.ts`: lazy `getSupabaseAdmin()`.
- `lib/server/auth.ts`: one `authenticateRequest()` for all routes; optional
  `MULEWATCH_ANALYST_EMAILS` allowlist (403); outage → 503.
- `/api/alerts` also returns `source_account_id` / `destination_account_id`
  (additive) so an alert can open the network; returns `limit`.
- `/api/predict` passes through `decision_threshold` (additive).

**Client**
- New route group `(workspace)` with session gate and shell; `/alerts`,
  `/network`, `/evaluate`; `/` and `/dashboard` redirect to `/alerts`.
- Login: sign-in by default, sign-up behind `NEXT_PUBLIC_ENABLE_SIGNUP`,
  validated `?next=` (no open redirect).
- `lib/api-client.ts`: token attachment, timeouts, abort, offline detection,
  typed `ApiError`, 401 broadcast → sign-out.
- Alert queue: URL-synced search/filters/sort/pagination, stale-response
  cancellation, mobile card layout, review drawer.
- Network: pure `graph-model.ts` (dedupe, dangling edges, self-loops, cycles,
  position-preserving merge, 400-account cap), per-account request
  de-duplication and caching, fit-once behaviour, accessible paths and
  transactions tables, account and path inspectors, `?account=` deep link.
- Evaluate: grouped form, field-level validation with focus, working retry that
  reuses the idempotency key, cold-start progress, probability-vs-threshold
  display.

**Removed (moved to a backup folder, later deleted at the owner's request)** (verified unreferenced by static search
after the new pages replaced them): `components/AlertQueue.tsx`,
`PredictionPanel.tsx`, `TransactionNetwork.tsx`, `app/supabase-test/page.tsx`,
and the five create-next-app SVGs in `public/`.

**Tests added** (46 → 74): queue filter parsing/sorting/pagination, graph
model edge cases, formatting, redirect validation, allowlist, 403/503 route
paths, threshold pass-through.

## 5. Verification after the changes

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean. |
| `npm run lint` | Clean (0 errors, 0 warnings). |
| `npm test` | 74 / 74 passed. |
| `npm run build` | Passes with no env vars set. |
| `pytest api/tests` | 4 / 4 passed. |
| Secrets in client bundle | `grep` of `.next/static` for service-role/admin/API-key names: none. |
| `npm audit --omit=dev` | 0 vulnerabilities. |

**Browser walkthrough** (built-in browser, dev server). Supabase was replaced
by a local mock implementing the auth and PostgREST calls the app makes, with
synthetic fixtures; the **real** route handlers and the **real** FastAPI
service with the trained model were used. Verified: signed-out redirect with
`next` preserved; wrong-password message; sign-in; queue filters from URL,
search, out-of-range page clamping, sort; open → investigating → resolved
through PATCH with confirmation; drawer Escape and focus return; graph render
and legend; account history via the table path; `?account=` deep link;
Evaluate validation, a low score (12.55 %) and a flagged score (99.14 %, alert
created and visible in the queue); model service down → retryable error with
inputs kept, then recovery; expired token → signed out to sign-in; Supabase
down → retryable error without sign-out (after fix 11); 375 px width with no
horizontal overflow.

**Not verified:** real Supabase data and RLS, the Render deployment and its
cold-start timing, screen-reader output (structure and labels were checked, an
actual screen reader was not run), contrast with a measuring tool, performance
on graphs near the 400-account cap.

## 6. Open risks and recommendations

1. **Set `MULEWATCH_ANALYST_EMAILS` and disable public sign-up in Supabase.**
   Without both, any registered user can read every transaction.
2. Rotate the Supabase secret key in root `.env` / `env` if either file has
   ever been shared or committed elsewhere; delete the duplicate `env`.
3. Add the RPC, tables, indexes and RLS policies as migrations in the repo.
   The function should cap recursion depth (currently expected ≤ 2), carry a
   visited-path array to prevent cycles, and enforce `edge_limit` server-side.
   Useful indexes: `transactions(source_account_id)`,
   `transactions(destination_account_id)`, `alerts(status, created_at desc)`,
   and a unique index on `alerts(transaction_id, reason)` to make alert
   creation race-free (the route only does a read-then-insert).
4. Record who changed an alert and when (audit table) before using this for
   real review work.
5. Move alert filtering and pagination to the server once queues exceed 100.
6. The canvas zooms on mouse wheel, which can trap page scrolling; consider
   requiring a modifier key.

## 7. Verification against the real Supabase project (2026-10-21)

Run with `frontend/.env.local`, the live Supabase project and the Render model.

| Check | Result |
| --- | --- |
| Row counts | 192,793 accounts · 100,004 transactions · 129 alerts (128 unresolved, all PaySim demonstrations; 0 model alerts before testing) |
| Publishable key direct access | `permission denied` on `accounts`, `transactions`, `alerts` and the RPC |
| `/api/*` without / with a forged token | 401 on all five routes |
| Supabase sign-up | **Enabled** (`disable_signup: false`) — see risk 1 |
| Alert queue | Loads 100 of 128 and shows the cap notice; sources and counts match the database |
| Network RPC | Returns **10 rows** for `edge_limit => 100` (14 accounts, 6 two-hop paths); 2.5–6 s per call |
| Account history | Loads; already-drawn transactions de-duplicated |
| Alert status | One alert (`58c8e3e4…`) set to investigating and back to open; both confirmed in the database |
| Evaluate | One PAYMENT of 250 scored by Render after a cold start: 0.00 %, saved as `mulewatch-ui-9d9e12db…`, no alert, no accounts created |

Data written by this test: one row in `transactions` (reference above). The
alert status change was reverted.

Follow-ups from this run: 28 unresolved alerts are beyond the 100-alert window
(server-side pagination needed); the RPC's 10-row output and multi-second
latency should be checked in the SQL function itself.

## 8. Server-side alert pagination (2026-10-21)

`/api/alerts` now filters, sorts and pages in Postgres (25 per page, exact
count, transaction embedded via the foreign key), replacing the 100-alert
window with client-side filtering. Verified on the real project: all 128
unresolved alerts reached across 6 pages with no duplicates; `?page=99` and a
filtered out-of-range page both fall back to the last page; reference search
and alert-ID search each return the single expected alert; a critical-severity
filter returns 0, matching the database. Two bugs were found and fixed during
this check: a URL ↔ page ping-pong when paging, and a fallback that counted
all alerts instead of the filtered set. Each page takes 4–5.5 s from this
machine, dominated by network latency to Supabase (TCP/TLS setup alone
reached 1–2.5 s); it has not been measured from a deployed environment.

## 9. Completion pass (2026-10-21) — checklist and evidence

Environment: local `next dev` on macOS, built-in browser, real Supabase
project and Render model. All latency numbers are from this machine and depend
on its network path to Supabase; production latency was not measured.

### Performance (same session, before → after)

| Measurement | Before | After |
| --- | --- | --- |
| Token verification (`Server-Timing: auth`, 8 requests) | 161–802 ms, median ≈ 280 ms | 0.9–3.7 ms |
| `/api/alerts` round trip, 8 sequential requests | median ≈ 1,020 ms (598–2,044) | median ≈ 707 ms (339–1,745) |
| Next/Previous click → rows rendered | 1,123–2,531 ms (4 clicks) | 399–557 ms, median ≈ 504 ms (7 clicks) |
| Database requests per page change | 3 (page + 2 summary counts) | 1 |

Causes and fixes:
1. **Auth round trip per request.** `getUser()` called Supabase Auth before
   every query. Now `getClaims()` verifies the ES256 token locally with a
   module-level client so the JWKS cache persists (`lib/server/auth.ts`).
2. **Summary counts on every page.** The unfiltered open/investigating counts
   were re-fetched on each page and were usually the slowest of the three
   parallel requests. Clients now send `summary=0` when paging/filtering and
   refetch the summary on first load, Refresh and status changes.
3. **Server navigation per page change.** `router.replace()` made an RSC
   request (~650 ms) before the data fetch. `history.replaceState` updates the
   URL and `useSearchParams` without it.

Remaining time is the single PostgREST request (≈ 240–800 ms, mostly network)
plus ≈ 150 ms of client work. Indexes are prepared but not applied; at 129
alerts they are not the bottleneck.

### Verified on real data (via the running app's API and UI)
- Pagination invariants for default, `status=open`, `status=investigating`,
  `source=model_prediction`, `source=ground_truth_demo`: rows + unverified =
  total, no duplicate IDs, all non-final pages full.
- `sort=newest` / `oldest` monotonic across all 128 alerts. All 128 share one
  `created_at`, so the `id` tie-breaker is what keeps pages disjoint.
- Combined filters, alert-ID and transaction-ID search, invalid params
  (`page=abc`, unknown severity, removed `sort=amount`) fall back to defaults,
  500-character query accepted and truncated, rapid filter changes collapse to
  one request with the final state shown.
- Security: tampered signature, edited claims, `alg: none` → 401 (GET and
  PATCH); network and history routes work with real tokens.
- No secret value from `.env.local` appears in `.next/static` (the only
  `sb_secret_` string is supabase-js's key-format check).

### Defects fixed in this pass
| Sev | Defect | Fix | Test |
| --- | --- | --- | --- |
| P2 | Searching `*` matched every alert (PostgREST wildcard alias) | Escape `*` with `%`, `_`, `\` | route test + real data: `*` → 0 |
| P2 | Concurrent retries could insert duplicate alerts | Prepared unique index; route treats `23505` as existing | route test |
| P2 | ~1.85 s median page change | See performance above | timing measured |
| P3 | Service-role tokens not explicitly rejected | Require `role = authenticated` | route test |

### Not done / blocked
- Migration `20261021000000_alert_queue_indexes.sql` applied by the project owner via the Supabase SQL Editor on 2026-10-21. Afterwards, all 128 alerts were reachable with no duplicates for the default, PaySim-source and newest sorts; page queries took 207–2,318 ms, the same network-bound range as before.
- Public sign-up still enabled in Supabase; `MULEWATCH_ANALYST_EMAILS` unset.
- RPC returns 10 rows for `edge_limit => 100`; its SQL is not in the repo.
- No production or deployed-environment measurement.
