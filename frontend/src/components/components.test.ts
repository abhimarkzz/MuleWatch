import { describe, expect, it } from "vitest";
import { alertScore, DEFAULT_FILTERS, parseFilters, serializeFilters } from "@/lib/alert-filters";
import {
  countNewAccounts,
  graphFromNetwork,
  mergeHistory,
  type HistoryTransaction,
} from "./network/graph-model";

describe("alert queue filters", () => {
  it("round-trips through the URL and drops invalid values", () => {
    const filters = { ...DEFAULT_FILTERS, q: "abc", severity: "high" as const, page: 3 };
    expect(parseFilters(new URLSearchParams(serializeFilters(filters)))).toEqual(filters);

    const junk = parseFilters(new URLSearchParams("severity=extreme&status=resolved&page=-4&sort=amount"));
    expect(junk).toEqual(DEFAULT_FILTERS);
  });

  it("omits defaults from the serialised URL", () => {
    expect(serializeFilters(DEFAULT_FILTERS)).toBe("");
  });

  it("trims and bounds the search text and page", () => {
    const parsed = parseFilters(new URLSearchParams(`q=${"x".repeat(300)}%20&page=99999`));
    expect(parsed.q).toHaveLength(120);
    expect(parsed.page).toBe(1);
  });

  it("falls back to the transaction score when the alert has none", () => {
    expect(alertScore({ risk_score: null, transaction: { model_score: "0.4" } })).toBe(0.4);
    expect(alertScore({ risk_score: 0.9, transaction: null })).toBe(0.9);
    expect(alertScore({ risk_score: null, transaction: null })).toBeNull();
  });
});

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function link(id: string, source: string, target: string, flags: { model?: boolean; paysim?: boolean } = {}) {
  return {
    id,
    source,
    target,
    amount: "10",
    transaction_type: "TRANSFER",
    transaction_step: 1,
    model_score: null,
    model_flagged: flags.model ?? false,
    ground_truth_demo: flags.paysim ?? false,
    hop: 1,
  };
}

function historyRow(id: string, source: string | null, target: string | null): HistoryTransaction {
  return {
    id,
    source_account_id: source,
    destination_account_id: target,
    transaction_type: "CASH_OUT",
    amount: 5,
    transaction_step: 2,
    predicted_is_fraud: false,
    model_score: 0.1,
    metadata: { dataset: "PaySim", ground_truth_is_fraud: 1 },
  };
}

describe("network graph model", () => {
  it("drops duplicate and dangling edges and keeps cycles", () => {
    const graph = graphFromNetwork({
      nodes: [{ id: A }, { id: B }],
      links: [link("t1", A, B, { model: true }), link("t1", A, B), link("t2", B, A), link("t3", A, C)],
    });

    expect(graph.links.map((l) => l.id)).toEqual(["t1", "t2"]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.find((n) => n.id === A)).toMatchObject({ degree: 2, outflow: 10, inflow: 10, linkedToModelFlag: true });
  });

  it("separates model flags from PaySim labels", () => {
    const graph = graphFromNetwork({ nodes: [{ id: A }, { id: B }], links: [link("t1", A, B, { paysim: true })] });
    expect(graph.nodes.every((n) => n.linkedToPaySimLabel && !n.linkedToModelFlag)).toBe(true);
    expect(graph.links[0]).toMatchObject({ paySimLabel: true, modelFlagged: false, amount: 10 });
  });

  it("merges history without duplicating edges and preserves positions", () => {
    const graph = graphFromNetwork({ nodes: [{ id: A }, { id: B }], links: [link("t1", A, B)] });
    graph.nodes[0].x = 42;

    const history = [historyRow("t1", A, B), historyRow("t9", B, C), historyRow("t10", null, A)];
    expect(countNewAccounts(graph, history)).toBe(1);

    const merged = mergeHistory(graph, history, B);
    expect(merged.links.map((l) => l.id)).toEqual(["t1", "t9"]);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual([A, B, C].sort());
    expect(merged.nodes.find((n) => n.id === A)?.x).toBe(42);
    expect(merged.links[1]).toMatchObject({ paySimLabel: true, hop: null });
  });

  it("adds a focused account even when it has no history", () => {
    const merged = mergeHistory({ nodes: [], links: [] }, [], A);
    expect(merged.nodes.map((n) => n.id)).toEqual([A]);
  });

  it("handles an empty or malformed response", () => {
    expect(graphFromNetwork({ nodes: [], links: [] })).toEqual({ nodes: [], links: [] });
    // @ts-expect-error simulating an unexpected payload shape
    expect(graphFromNetwork({})).toEqual({ nodes: [], links: [] });
  });
});
