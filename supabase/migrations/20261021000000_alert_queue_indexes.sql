-- MuleWatch: indexes for the server-side alert queue and race-free alert
-- creation. Prepared for review; NOT applied. Run in the Supabase SQL editor
-- or with `supabase db push` after reviewing.
--
-- Safe to re-run (IF NOT EXISTS). Additive only: no data is changed.
-- On a large table, prefer CREATE INDEX CONCURRENTLY, run statement by
-- statement outside a transaction.

-- /api/alerts filters on status <> 'resolved' and sorts by risk, then time,
-- then id (default "Highest risk"). A partial index covers exactly that.
create index if not exists alerts_unresolved_risk_idx
  on public.alerts (risk_score desc nulls last, created_at desc, id)
  where status <> 'resolved';

-- "Newest" / "Oldest" sorts and the open/investigating summary counts.
create index if not exists alerts_status_created_idx
  on public.alerts (status, created_at desc, id);

-- /api/predict checks for an existing alert before inserting one; under
-- concurrent retries both requests can pass that check. A unique index makes
-- the database reject the duplicate. Verified on 2026-10-21: the 129 existing
-- alerts contain no duplicate (transaction_id, reason) pairs.
create unique index if not exists alerts_transaction_reason_key
  on public.alerts (transaction_id, reason);

-- Reference search uses ILIKE '%fragment%', which a B-tree cannot serve.
-- With 100k transactions a sequential scan is acceptable; enable this if
-- search becomes slow:
--   create extension if not exists pg_trgm;
--   create index if not exists transactions_external_id_trgm_idx
--     on public.transactions using gin (external_transaction_id gin_trgm_ops);

-- Rollback:
--   drop index if exists public.alerts_unresolved_risk_idx;
--   drop index if exists public.alerts_status_created_idx;
--   drop index if exists public.alerts_transaction_reason_key;
