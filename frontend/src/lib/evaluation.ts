import { ApiError } from "@/lib/api-client";

/** /api/predict's synchronous result. */
export type PredictionResult = {
  transaction_id: string;
  external_transaction_id: string;
  predicted_is_fraud: boolean;
  fraud_probability: number;
  model_version: string;
  decision_threshold?: number | null;
  saved_to_supabase: boolean;
  alert_created: boolean;
};

/** /api/transactions/queue's 202: accepted by Kafka, not yet scored. */
export type QueuedResult = {
  status: "queued";
  prediction: "pending";
  external_transaction_id: string;
  topic: string;
  partition: number | null;
  offset: string | null;
};

export type EvaluationOutcome =
  | { kind: "queued"; queued: QueuedResult }
  | { kind: "scored"; prediction: PredictionResult };

/**
 * Turns an evaluation response into what the page shows. A queued response
 * must never be displayed as a score: it only means the broker accepted it.
 */
export function interpretEvaluation(body: unknown): EvaluationOutcome {
  if (typeof body === "object" && body !== null) {
    const value = body as Record<string, unknown>;
    if (value.status === "queued" && value.prediction === "pending" && typeof value.external_transaction_id === "string") {
      return { kind: "queued", queued: value as unknown as QueuedResult };
    }
    if (typeof value.predicted_is_fraud === "boolean" && typeof value.fraud_probability === "number") {
      return { kind: "scored", prediction: value as unknown as PredictionResult };
    }
  }
  throw new ApiError("The server returned an unexpected response.", 502, false);
}
