-- PROPOSAL ONLY: not a migration, not applied. Review first, then run
-- statement by statement in the Supabase SQL Editor (outside a transaction,
-- because of CONCURRENTLY).
--
-- Why indexes, not TimescaleDB or partitioning:
--  * The ledger has ~100k rows. Partitioning a populated table means creating
--    a new partitioned table and copying every row (a rewrite), and it makes
--    the unique constraint on external_transaction_id harder to keep, because
--    unique keys on a partitioned table must include the partition key.
--    /api/predict's idempotent upsert depends on that constraint.
--  * Supabase has deprecated TimescaleDB on Postgres 17 projects. Check before
--    planning on it:
--      select version();
--      select name, default_version, installed_version
--      from pg_available_extensions where name = 'timescaledb';
--  * At this size, indexes that match the real queries give the gain:
--      - Copilot: source_account_id = $1 AND transaction_step in a range
--      - Account history: source_account_id = $1 OR destination_account_id = $1
--        ORDER BY transaction_step DESC (Postgres can BitmapOr the two)
--
-- Check what exists first (read-only):
--   select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename = 'transactions';
-- Skip any statement an existing index already covers.
--
-- Risks: CONCURRENTLY doesn't lock writes, but it takes longer and can leave
-- an INVALID index if it fails (drop it and retry). Each index costs some
-- write overhead and storage (small at this size).

create index concurrently if not exists transactions_source_step_idx
  on public.transactions (source_account_id, transaction_step);

create index concurrently if not exists transactions_destination_step_idx
  on public.transactions (destination_account_id, transaction_step);

-- Verify a plan uses them (replace the UUID):
--   explain analyze select id from public.transactions
--   where source_account_id = '00000000-0000-0000-0000-000000000000'
--     and transaction_step > 76 and transaction_step < 124;
--
-- Rollback:
--   drop index concurrently if exists public.transactions_source_step_idx;
--   drop index concurrently if exists public.transactions_destination_step_idx;
