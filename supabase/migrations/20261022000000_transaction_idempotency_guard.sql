-- MuleWatch: guarantees the uniqueness that idempotent transaction delivery
-- (QStash retries, browser retries) relies on.
--
-- Applied 2026-10-22 in the SQL Editor; it was a no-op. Checked first:
-- no duplicate external_transaction_id values, and the project already had
-- CREATE UNIQUE INDEX transactions_external_transaction_id_key, so the
-- block below created nothing.
--
-- /api/predict upserts with on_conflict=external_transaction_id. PostgREST
-- rejects that (error 42P10) unless a unique constraint or index on exactly
-- that column exists, and the upsert succeeded against the project on
-- 2026-10-21, so the constraint very likely exists already. This block checks
-- the catalog and creates an index only if none is found. Additive; no data
-- changes. It fails (rather than deleting anything) if duplicates exist.
do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.transactions'::regclass
      and i.indisunique
      and i.indnatts = 1
      and a.attname = 'external_transaction_id'
  ) then
    create unique index transactions_external_transaction_id_key
      on public.transactions (external_transaction_id);
  end if;
end $$;

-- Check (read-only) before applying; any rows mean duplicates exist:
--   select external_transaction_id, count(*) from public.transactions
--   group by 1 having count(*) > 1 limit 20;
--
-- Alerts: alerts_transaction_reason_key from 20261021000000 (applied
-- 2026-10-21) already makes (transaction_id, reason) unique.
--
-- Rollback: none. On this project the index named above pre-dates this
-- migration and backs /api/predict's upsert; do NOT drop it.
