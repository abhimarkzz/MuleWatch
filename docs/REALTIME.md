# Live fraud notifications (Supabase Realtime)

While an analyst is signed in, the workspace subscribes to `INSERT` events on
`public.transactions`, using the browser Supabase client on the channel
`custom-all-channel`.

- **What it shows:** when a new row has `predicted_is_fraud = true`, a red
  slide-in notice (`role="alert"`) appears with the transaction reference,
  amount, model score and a link to Alerts.
- **What it ignores:** other inserts, and repeats of an event it has already
  shown.
- **Alert queue:** an open queue refetches its current page about 2 s later,
  once `/api/predict` has written the alert.
- **Connection state:**
  - If the channel errors or times out, a "Live fraud alerts are paused" notice
    shows while Realtime rejoins on its own.
  - The channel is removed when the workspace unmounts, for example on sign-out.

The code is in:

- `frontend/src/lib/realtime-fraud.ts` (logic)
- `frontend/src/components/FraudNotifier.tsx` (UI)

## Manual configuration (Supabase SQL Editor)

Nothing below has been run against your project. Steps 1 and 2 are read-only.

**1. Is `transactions` in the Realtime publication?**

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'transactions';
```

If that returns no row, add it. This snippet adds the table only if it's
missing, and never drops or recreates the publication:

```sql
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions'
  ) then
    alter publication supabase_realtime add table public.transactions;
  end if;
end $$;
```

You can also turn it on in Database → Publications → `supabase_realtime`.

**2. Does a signed-in user's RLS allow reading the row?** Realtime only
delivers a row to a subscriber who could `SELECT` it.

```sql
select relrowsecurity from pg_class where oid = 'public.transactions'::regclass;

select policyname, cmd, roles, qual
from pg_policies
where schemaname = 'public' and tablename = 'transactions';
```

Notifications need an existing `SELECT` policy for the `authenticated` role.

- **What's already verified:** the anonymous (publishable-key) role is refused
  (`42501`, permission denied), checked on 2026-10-23.
- **If there's no authenticated policy:** notifications won't arrive. Don't add
  a broad `using (true)` policy just for this feature, because it would let
  every signed-in user read every transaction directly.
- **If there is one:** any user who can sign in can already read transactions
  through the browser client. This was true before this feature. Disable public
  sign-up, and consider a policy limited to your analyst accounts.

## What a notification exposes

`postgres_changes` sends the whole inserted row to the subscriber's browser.
That's the same data their RLS already lets them `SELECT`. The UI keeps only the
reference, amount and score.

## Verifying live

Live Realtime has **not** been verified yet; the unit tests use a fake client.

1. Deploy the app.
2. Run the checks above.
3. Keep `/alerts` open while signed in.
4. Submit a transaction the model flags, using Evaluate or the queue.
5. A red notice should appear within a few seconds of the consumer saving it,
   and the queue should refresh by itself.
