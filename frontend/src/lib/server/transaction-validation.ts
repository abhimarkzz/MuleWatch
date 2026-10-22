/**
 * The transaction rules enforced by /api/predict, for routes that must reject
 * the same payloads before the handler sees them (the Kafka producer).
 * /api/predict keeps its own copy so its behaviour is untouched; the parity
 * test in transactions/queue/route.test.ts fails if the two drift apart.
 */

export const TRANSACTION_TYPES = ["PAYMENT", "TRANSFER", "CASH_OUT", "CASH_IN", "DEBIT"] as const;

export type TransactionPayload = {
  step: number;
  type: (typeof TRANSACTION_TYPES)[number];
  amount: number;
  oldbalanceOrg: number;
  oldbalanceDest: number;
  orig_txn_count_before: number;
  dest_txn_count_before: number;
  dest_is_merchant: 0 | 1;
  external_transaction_id?: string;
  source_account_external_id?: string;
  destination_account_external_id?: string;
};

export type ValidationResult =
  | { ok: true; transaction: TransactionPayload }
  | { ok: false; error: string };

const NUMERIC_FIELDS = [
  "step",
  "amount",
  "oldbalanceOrg",
  "oldbalanceDest",
  "orig_txn_count_before",
  "dest_txn_count_before",
  "dest_is_merchant",
] as const;

const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const nonNegativeInt = (v: unknown) => nonNegative(v) && Number.isInteger(v);
const optionalId = (v: unknown, max: number) =>
  v === undefined || (typeof v === "string" && v.length > 0 && v.length <= max);

/** Same checks, order and messages as /api/predict. */
export function validateTransaction(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.type !== "string" || !(TRANSACTION_TYPES as readonly string[]).includes(body.type)) {
    return { ok: false, error: "Invalid transaction type." };
  }
  if (NUMERIC_FIELDS.some((f) => typeof body[f] !== "number" || !Number.isFinite(body[f]))) {
    return { ok: false, error: "All numeric fields must contain valid numbers." };
  }
  if (
    !nonNegativeInt(body.step) ||
    !nonNegative(body.amount) ||
    !nonNegative(body.oldbalanceOrg) ||
    !nonNegative(body.oldbalanceDest) ||
    !nonNegativeInt(body.orig_txn_count_before) ||
    !nonNegativeInt(body.dest_txn_count_before) ||
    (body.dest_is_merchant !== 0 && body.dest_is_merchant !== 1) ||
    !optionalId(body.external_transaction_id, 150) ||
    !optionalId(body.source_account_external_id, 200) ||
    !optionalId(body.destination_account_external_id, 200)
  ) {
    return { ok: false, error: "One or more transaction fields are invalid." };
  }
  return { ok: true, transaction: body as unknown as TransactionPayload };
}
