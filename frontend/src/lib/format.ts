/** Parses numeric columns that PostgREST may return as strings. */
export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const amountFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** PaySim amounts carry no currency, so none is shown. */
export function formatAmount(value: unknown): string {
  const amount = toFiniteNumber(value);
  return amount === null ? "—" : amountFormatter.format(amount);
}

/** Model scores are probabilities in [0, 1]. Anything else is not displayed. */
export function formatProbability(value: unknown, digits = 1): string {
  const score = toFiniteNumber(value);
  if (score === null || score < 0 || score > 1) return "—";
  return `${(score * 100).toFixed(digits)}%`;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return "—";
  return id.length > length ? id.slice(0, length) : id;
}

export function accountLabel(id: string): string {
  return `Account ${shortId(id)}`;
}
