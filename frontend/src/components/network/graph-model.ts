import { accountLabel, toFiniteNumber } from "@/lib/format";
import { isPaySimFraudLabel } from "@/lib/risk";

/** Hard cap on accounts drawn at once; expansion beyond it is refused. */
export const MAX_GRAPH_NODES = 400;

export type ApiNode = { id: string; name?: string };

export type ApiLink = {
  id: string;
  source: string;
  target: string;
  amount: number | string | null;
  transaction_type: string | null;
  transaction_step: number | null;
  model_score: number | string | null;
  model_flagged: boolean;
  ground_truth_demo: boolean;
  hop: number;
};

export type TwoHopPath = {
  id: string;
  source: string;
  intermediary: string;
  destination: string;
  transaction_ids: string[];
  classification: "model_flagged" | "paysim_demo" | "unflagged";
};

export type NetworkResponse = {
  nodes: ApiNode[];
  links: ApiLink[];
  twoHopPaths?: TwoHopPath[];
};

export type HistoryTransaction = {
  id: string;
  source_account_id: string | null;
  destination_account_id: string | null;
  transaction_type: string | null;
  amount: number | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | null;
  metadata: Record<string, unknown> | null;
};

export type HistoryResponse = {
  transactions: HistoryTransaction[];
  stats?: { hasMore?: boolean };
};

export type GraphNode = {
  id: string;
  name: string;
  /** Touches at least one transaction the model flagged. Association only. */
  linkedToModelFlag: boolean;
  /** Touches at least one transaction carrying the PaySim isFraud label. */
  linkedToPaySimLabel: boolean;
  degree: number;
  inflow: number;
  outflow: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

export type GraphLink = {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  amount: number | null;
  transactionType: string;
  step: number | null;
  modelScore: number | null;
  modelFlagged: boolean;
  paySimLabel: boolean;
  /** CTE hop depth, or null when the edge was added by expanding an account. */
  hop: number | null;
};

export type Graph = { nodes: GraphNode[]; links: GraphLink[] };

export const EMPTY_GRAPH: Graph = { nodes: [], links: [] };

export function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function blankNode(id: string, previous?: GraphNode): GraphNode {
  return {
    // Keep simulation coordinates so existing accounts do not jump on merge.
    x: previous?.x,
    y: previous?.y,
    vx: previous?.vx,
    vy: previous?.vy,
    fx: previous?.fx,
    fy: previous?.fy,
    id,
    name: previous?.name ?? accountLabel(id),
    linkedToModelFlag: false,
    linkedToPaySimLabel: false,
    degree: 0,
    inflow: 0,
    outflow: 0,
  };
}

/**
 * Rebuilds node attributes from the link list. Links are deduplicated by
 * transaction ID, self-loops are kept (they are real transactions) and links
 * referencing missing accounts are dropped rather than crashing the canvas.
 */
function finalize(nodeSeed: Map<string, GraphNode>, links: GraphLink[]): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const [id, node] of nodeSeed) nodes.set(id, blankNode(id, node));

  const kept: GraphLink[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (!source || !target || seen.has(link.id)) continue;
    seen.add(link.id);

    if (!nodes.has(source)) nodes.set(source, blankNode(source));
    if (!nodes.has(target)) nodes.set(target, blankNode(target));

    const from = nodes.get(source)!;
    const to = nodes.get(target)!;
    from.degree += 1;
    to.degree += source === target ? 0 : 1;
    from.outflow += link.amount ?? 0;
    to.inflow += link.amount ?? 0;

    if (link.modelFlagged) from.linkedToModelFlag = to.linkedToModelFlag = true;
    if (link.paySimLabel) from.linkedToPaySimLabel = to.linkedToPaySimLabel = true;

    kept.push({ ...link, source, target });
  }

  return { nodes: [...nodes.values()], links: kept };
}

export function graphFromNetwork(response: NetworkResponse): Graph {
  const seed = new Map<string, GraphNode>();

  for (const node of response.nodes ?? []) {
    if (typeof node?.id === "string" && node.id) seed.set(node.id, blankNode(node.id));
  }

  const links: GraphLink[] = (response.links ?? [])
    .filter((link) => typeof link?.id === "string" && seed.has(link.source) && seed.has(link.target))
    .map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      amount: toFiniteNumber(link.amount),
      transactionType: link.transaction_type ?? "UNKNOWN",
      step: link.transaction_step ?? null,
      modelScore: toFiniteNumber(link.model_score),
      modelFlagged: link.model_flagged === true,
      paySimLabel: link.ground_truth_demo === true,
      hop: Number.isFinite(link.hop) ? link.hop : null,
    }));

  return finalize(seed, links);
}

export function linkFromHistory(transaction: HistoryTransaction): GraphLink | null {
  if (!transaction.source_account_id || !transaction.destination_account_id) return null;

  return {
    id: transaction.id,
    source: transaction.source_account_id,
    target: transaction.destination_account_id,
    amount: toFiniteNumber(transaction.amount),
    transactionType: transaction.transaction_type ?? "UNKNOWN",
    step: transaction.transaction_step ?? null,
    modelScore: toFiniteNumber(transaction.model_score),
    modelFlagged: transaction.predicted_is_fraud === true,
    paySimLabel: isPaySimFraudLabel(transaction.metadata),
    hop: null,
  };
}

/** Accounts the merge would introduce, used to enforce MAX_GRAPH_NODES. */
export function countNewAccounts(graph: Graph, transactions: HistoryTransaction[]): number {
  const known = new Set(graph.nodes.map((node) => node.id));
  const added = new Set<string>();

  for (const transaction of transactions) {
    for (const id of [transaction.source_account_id, transaction.destination_account_id]) {
      if (id && !known.has(id)) added.add(id);
    }
  }

  return added.size;
}

export function mergeHistory(graph: Graph, transactions: HistoryTransaction[], ensureAccount?: string): Graph {
  const seed = new Map(graph.nodes.map((node) => [node.id, node]));
  if (ensureAccount && !seed.has(ensureAccount)) seed.set(ensureAccount, blankNode(ensureAccount));

  const additions = transactions.map(linkFromHistory).filter((link): link is GraphLink => link !== null);
  return finalize(seed, [...graph.links, ...additions]);
}
