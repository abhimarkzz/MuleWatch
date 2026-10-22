import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Live "model flagged a transaction" notifications from Supabase Realtime.
 *
 * Uses the browser client, so delivery is limited by the signed-in user's RLS
 * policies on public.transactions; nothing here widens access. The INSERT
 * payload carries the whole row, but only the reference, amount and score
 * are kept for display.
 */

export const FRAUD_CHANNEL = "custom-all-channel";
/** Fired on window so open pages (the alert queue) can refresh. */
export const FRAUD_INSERT_EVENT = "mulewatch:fraud-insert";
const MAX_REMEMBERED = 500;

export type FraudToast = {
  id: string;
  reference: string | null;
  amount: number | null;
  score: number | null;
};

export type LiveStatus = "connecting" | "live" | "reconnecting" | "closed";

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The display details of a model-flagged insert, or null to ignore it. */
export function toFraudToast(payload: unknown): FraudToast | null {
  const row = (payload as { new?: Record<string, unknown> } | null)?.new;
  if (!row || row.predicted_is_fraud !== true || typeof row.id !== "string") return null;
  return {
    id: row.id,
    reference: typeof row.external_transaction_id === "string" ? row.external_transaction_id.slice(0, 150) : null,
    amount: finite(row.amount),
    score: finite(row.model_score),
  };
}

/** Remembers recent transaction IDs so a redelivered event toasts once. */
export function createDeduper(limit = MAX_REMEMBERED) {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return true;
  };
}

/**
 * Subscribes to transaction inserts and returns the cleanup function.
 * Realtime rejoins dropped channels on its own; statuses are mapped so the UI
 * can say when live updates are paused rather than failing silently.
 */
export function subscribeToFraudInserts(
  client: SupabaseClient,
  handlers: { onFraud: (toast: FraudToast) => void; onStatus: (status: LiveStatus) => void },
): () => void {
  const isNew = createDeduper();
  handlers.onStatus("connecting");

  const channel: RealtimeChannel = client
    .channel(FRAUD_CHANNEL)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "transactions" }, (payload) => {
      const toast = toFraudToast(payload);
      if (toast && isNew(toast.id)) handlers.onFraud(toast);
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") handlers.onStatus("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") handlers.onStatus("reconnecting");
      else if (status === "CLOSED") handlers.onStatus("closed");
    });

  return () => {
    void client.removeChannel(channel);
  };
}
