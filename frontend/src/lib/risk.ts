/**
 * Vocabulary shared by every screen. MuleWatch keeps four ideas separate:
 *  - model risk: a Random Forest probability and the severity derived from it
 *  - ground truth: the synthetic PaySim `isFraud` label, used only for demos
 *  - review status: where an analyst is in the investigation
 *  - association: an account touched by a flagged transaction (not a finding)
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type AlertStatus = "open" | "investigating" | "resolved";
export type AlertSource = "model_prediction" | "ground_truth_demo";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
export const ALERT_STATUSES: AlertStatus[] = ["open", "investigating", "resolved"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const STATUS_LABEL: Record<AlertStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
};

export const SOURCE_LABEL: Record<AlertSource, string> = {
  model_prediction: "Model flag",
  ground_truth_demo: "PaySim label",
};

export const SOURCE_DESCRIPTION: Record<AlertSource, string> = {
  model_prediction:
    "The Random Forest score met the configured decision threshold. This is a prediction, not a confirmed finding.",
  ground_truth_demo:
    "Created from the synthetic PaySim isFraud label to demonstrate the workflow. It is not a model prediction.",
};

export function asSeverity(value: string | null | undefined): Severity | null {
  const lower = value?.toLowerCase();
  return SEVERITY_ORDER.includes(lower as Severity) ? (lower as Severity) : null;
}

export function asStatus(value: string | null | undefined): AlertStatus | null {
  const lower = value?.toLowerCase();
  return ALERT_STATUSES.includes(lower as AlertStatus) ? (lower as AlertStatus) : null;
}

export function isPaySimFraudLabel(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.dataset === "PaySim" && String(metadata?.ground_truth_is_fraud) === "1";
}

/** Reason written by /api/predict when the model flags a transaction. */
export const MODEL_ALERT_REASON = "Random Forest flagged this transaction for review.";

/** Prefix written by scripts/upload_paysim_to_supabase.py for seeded alerts. */
export const PAYSIM_ALERT_REASON_PREFIX = "Demonstration alert from PaySim ground-truth label";
