import { toFiniteNumber } from "@/lib/format";
import { SEVERITY_ORDER, type AlertSource, type AlertStatus, type Severity } from "@/lib/risk";

/**
 * Alert queue query shared by the URL (browser) and /api/alerts (server), so
 * a link to a filtered page and the database query it produces always agree.
 */

export type SortKey = "risk" | "newest" | "oldest";

export type QueueFilters = {
  q: string;
  severity: Severity | "all";
  status: Exclude<AlertStatus, "resolved"> | "all";
  source: AlertSource | "all";
  sort: SortKey;
  page: number;
};

export const PAGE_SIZE = 25;

/** Longest search string accepted; longer input is truncated. */
export const MAX_QUERY_LENGTH = 120;

export const DEFAULT_FILTERS: QueueFilters = {
  q: "",
  severity: "all",
  status: "all",
  source: "all",
  sort: "risk",
  page: 1,
};

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Reads filters from query parameters, discarding anything unexpected. */
export function parseFilters(params: URLSearchParams): QueueFilters {
  const page = Number(params.get("page"));

  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    severity: pick(params.get("severity"), ["all", ...SEVERITY_ORDER], "all"),
    status: pick(params.get("status"), ["all", "open", "investigating"] as const, "all"),
    source: pick(params.get("source"), ["all", "model_prediction", "ground_truth_demo"] as const, "all"),
    sort: pick(params.get("sort"), ["risk", "newest", "oldest"] as const, "risk"),
    page: Number.isInteger(page) && page > 0 && page <= 10_000 ? page : 1,
  };
}

export function serializeFilters(filters: QueueFilters): string {
  const params = new URLSearchParams();

  for (const key of Object.keys(DEFAULT_FILTERS) as Array<keyof QueueFilters>) {
    const value = filters[key];
    if (value !== DEFAULT_FILTERS[key] && value !== "") params.set(key, String(value));
  }

  return params.toString();
}

/** Stored alert score, falling back to the transaction's model score. */
export function alertScore(alert: {
  risk_score: number | string | null;
  transaction: { model_score: number | string | null } | null;
}): number | null {
  return toFiniteNumber(alert.risk_score) ?? toFiniteNumber(alert.transaction?.model_score);
}
