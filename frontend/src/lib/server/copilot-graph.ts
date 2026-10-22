import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Builds the bounded, alert-centred temporal graph the Analyst Copilot sends
 * to the model. Everything is read server-side from Supabase; nothing the
 * browser sends is trusted beyond the alert ID.
 *
 * Time is PaySim's `transaction_step` (one step = one simulated hour), not
 * `created_at`: the seeded rows were bulk-loaded, so their `created_at`
 * values are load times shared by thousands of rows. The 24-hour rule matches
 * the temporal traversal: a next transaction must be strictly later than the
 * previous one and less than 24 hours after it.
 *
 * get_mulewatch_two_hop_transactions only accepts edge_limit (a global
 * sample), so it cannot start from one alert; these queries apply the same
 * two-hop, 24-hour rule around the alert's transaction instead.
 */

export const WINDOW_HOURS = 24;
export const MAX_EDGES_PER_QUERY = 25;

const TX_FIELDS =
  "id, source_account_id, destination_account_id, transaction_type, amount, transaction_step, model_score, predicted_is_fraud";

type TxRow = {
  id: string;
  source_account_id: string | null;
  destination_account_id: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  transaction_step: number | null;
  model_score: number | string | null;
  predicted_is_fraud: boolean | null;
};

export type CopilotEdge = {
  ref: string;
  role: "flagged" | "onward_from_receiver" | "other_from_sender";
  from: string;
  to: string;
  type: string | null;
  amount: number | null;
  hours_after_flagged: number;
  model_score: number | null;
  model_flagged: boolean;
};

export type CopilotGraph = {
  window_hours: number;
  time_basis: string;
  alert: { severity: string | null; status: string | null; risk_score: number | null; reason: string | null };
  edges: CopilotEdge[];
  observed: {
    sender_distinct_receivers_in_window: number;
    onward_transfers_from_receiver: number;
    layering_chain_observed: boolean;
    truncated: boolean;
  };
};

export type GraphResult =
  | { ok: true; graph: CopilotGraph }
  | { ok: false; status: 404 | 422 | 500; error: string };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function buildCopilotGraph(db: SupabaseClient, alertId: string): Promise<GraphResult> {
  const { data: alert, error } = await db
    .from("alerts")
    .select(`id, severity, status, risk_score, reason, transaction:transactions(${TX_FIELDS})`)
    .eq("id", alertId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: "Could not load the alert." };
  if (!alert) return { ok: false, status: 404, error: "Alert not found." };

  const seed = (Array.isArray(alert.transaction) ? alert.transaction[0] : alert.transaction) as TxRow | null;
  if (!seed || typeof seed.transaction_step !== "number" || !seed.source_account_id || !seed.destination_account_id) {
    return {
      ok: false,
      status: 422,
      error: "This alert's transaction has no linked accounts or time step, so there is no network to analyse.",
    };
  }
  const s0 = seed.transaction_step;

  const [onward, fanOut] = await Promise.all([
    // Hop 2: money leaving the receiver after the flagged transfer.
    db
      .from("transactions")
      .select(TX_FIELDS)
      .eq("source_account_id", seed.destination_account_id)
      .gt("transaction_step", s0)
      .lt("transaction_step", s0 + WINDOW_HOURS)
      .neq("id", seed.id)
      .order("transaction_step", { ascending: true })
      .limit(MAX_EDGES_PER_QUERY),
    // Fan-out: the sender's other transfers within 24 hours either side.
    db
      .from("transactions")
      .select(TX_FIELDS)
      .eq("source_account_id", seed.source_account_id)
      .gt("transaction_step", s0 - WINDOW_HOURS)
      .lt("transaction_step", s0 + WINDOW_HOURS)
      .neq("id", seed.id)
      .order("transaction_step", { ascending: true })
      .limit(MAX_EDGES_PER_QUERY),
  ]);
  if (onward.error || fanOut.error) return { ok: false, status: 500, error: "Could not load the transaction network." };

  // Opaque labels: the model sees structure, not account or record IDs.
  const labels = new Map<string, string>([
    [seed.source_account_id, "SENDER"],
    [seed.destination_account_id, "RECEIVER"],
  ]);
  const label = (id: string | null) => {
    if (!id) return "UNKNOWN";
    if (!labels.has(id)) labels.set(id, `ACCOUNT_${labels.size - 1}`);
    return labels.get(id)!;
  };

  let n = 0;
  const edge = (row: TxRow, role: CopilotEdge["role"]): CopilotEdge => ({
    ref: role === "flagged" ? "T0" : `T${++n}`,
    role,
    from: label(row.source_account_id),
    to: label(row.destination_account_id),
    type: row.transaction_type,
    amount: num(row.amount),
    hours_after_flagged: (row.transaction_step ?? s0) - s0,
    model_score: num(row.model_score),
    model_flagged: row.predicted_is_fraud === true,
  });

  const onwardRows = (onward.data ?? []) as TxRow[];
  const fanRows = (fanOut.data ?? []) as TxRow[];
  const edges = [edge(seed, "flagged"), ...onwardRows.map((r) => edge(r, "onward_from_receiver")), ...fanRows.map((r) => edge(r, "other_from_sender"))];

  const receivers = new Set([seed.destination_account_id, ...fanRows.map((r) => r.destination_account_id).filter(Boolean)]);

  return {
    ok: true,
    graph: {
      window_hours: WINDOW_HOURS,
      time_basis: "PaySim step; 1 step = 1 simulated hour",
      alert: {
        severity: alert.severity ?? null,
        status: alert.status ?? null,
        risk_score: num(alert.risk_score),
        reason: typeof alert.reason === "string" ? alert.reason.slice(0, 200) : null,
      },
      edges,
      observed: {
        sender_distinct_receivers_in_window: receivers.size,
        onward_transfers_from_receiver: onwardRows.length,
        layering_chain_observed: onwardRows.length > 0,
        truncated: onwardRows.length === MAX_EDGES_PER_QUERY || fanRows.length === MAX_EDGES_PER_QUERY,
      },
    },
  };
}
