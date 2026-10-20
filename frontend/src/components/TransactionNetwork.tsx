
"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ForceGraphMethods } from "react-force-graph-2d";
import { supabase } from "@/lib/supabase";

type Risk = "normal" | "model_flagged" | "ground_truth_demo";

type ApiNode = {
  id: string;
  name: string;
  label: string;
  model_flagged: boolean;
  ground_truth_demo: boolean;
  risk_level: Risk;
};

type ApiLink = {
  id: string;
  source: string;
  target: string;
  amount: number | string | null;
  type?: string;
  transaction_type: string | null;
  transaction_step: number | null;
  model_score: number | string | null;
  model_flagged: boolean;
  ground_truth_demo: boolean;
  hop: number;
  in_suspicious_model_path: boolean;
  in_paysim_demo_path: boolean;
  path_count: number;
};

type TwoHopPath = {
  id: string;
  source: string;
  intermediary: string;
  destination: string;
  transaction_ids: string[];
  model_flagged_signal: boolean;
  paysim_demo_signal: boolean;
  classification: "model_flagged" | "paysim_demo" | "unflagged";
};

type ApiStats = {
  node_count?: number;
  link_count?: number;
  model_flagged_transactions?: number;
  paysim_demo_transactions?: number;
  max_hop?: number;
  total_two_hop_paths?: number;
  unflagged_two_hop_paths?: number;
  suspicious_two_hop_paths?: number;
  paysim_demo_two_hop_paths?: number;
};

type NetworkResponse = {
  nodes?: ApiNode[];
  links?: ApiLink[];
  twoHopPaths?: TwoHopPath[];
  stats?: ApiStats;
  error?: string;
};

type AccountTransaction = {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  transaction_type: string | null;
  amount: number | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | null;
  metadata: Record<string, unknown> | null;
};

type HistoryResponse = {
  accountId?: string;
  transactions?: AccountTransaction[];
  stats?: {
    returned: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  error?: string;
};

type GraphNode = {
  id: string;
  name: string;
  kind: "account";
  risk: Risk;
  value: number;
  color: string;
  transactionCount: number;
  totalAmount: number;
  x?: number;
  y?: number;
};

type GraphLink = {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  label: string;
  amount: number;
  transactionType: string;
  transactionStep: number | null;
  modelScore: number | null;
  predictedIsFraud: boolean;
  groundTruthDemo: boolean;
  hop: number;
  inSuspiciousModelPath: boolean;
  inPaySimDemoPath: boolean;
  pathCount: number;
};

type GraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
};

type NetworkStats = {
  transactionsIncluded: number;
  modelFlaggedTransactions: number;
  groundTruthDemoTransactions: number;
  totalTwoHopPaths: number;
  unflaggedTwoHopPaths: number;
  suspiciousTwoHopPaths: number;
  paysimDemoTwoHopPaths: number;
  maxHop: number;
};

const EMPTY_STATS: NetworkStats = {
  transactionsIncluded: 0,
  modelFlaggedTransactions: 0,
  groundTruthDemoTransactions: 0,
  totalTwoHopPaths: 0,
  unflaggedTwoHopPaths: 0,
  suspiciousTwoHopPaths: 0,
  paysimDemoTwoHopPaths: 0,
  maxHop: 0,
};

const PAGE_SIZE = 50;

const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[460px] items-center justify-center text-sm text-slate-400">
        Initializing transaction network...
      </div>
    ),
  }
);

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;

  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function formatAmount(amount: number): string {
  return amount.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function accountName(id: string): string {
  return `Account ${id.slice(0, 8)}`;
}

function riskColor(risk: Risk): string {
  if (risk === "model_flagged") return "#ef4444";
  if (risk === "ground_truth_demo") return "#f59e0b";
  return "#10b981";
}

function riskFromFlags(
  modelFlagged: boolean,
  groundTruthDemo: boolean
): Risk {
  if (modelFlagged) return "model_flagged";
  if (groundTruthDemo) return "ground_truth_demo";
  return "normal";
}

function riskLabel(risk: Risk): string {
  if (risk === "model_flagged") return "Model-flagged";
  if (risk === "ground_truth_demo") return "PaySim demo label";
  return "No fraud flag in selected sample";
}

function pathLabel(
  classification: TwoHopPath["classification"]
): string {
  if (classification === "model_flagged") return "Model-flagged";
  if (classification === "paysim_demo") return "PaySim demonstration";
  return "Unflagged path";
}

function pathClasses(
  classification: TwoHopPath["classification"]
): string {
  if (classification === "model_flagged") {
    return "border-red-500/40 bg-red-500/10 text-red-300";
  }

  if (classification === "paysim_demo") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  }

  return "border-cyan-500/40 bg-cyan-500/10 text-cyan-300";
}

/**
 * Adds fetched account-history records to the current graph.
 * Existing transactions and nodes are deduplicated by their IDs.
 */
function mergeHistoryIntoGraph(
  current: GraphData,
  transactions: AccountTransaction[]
): GraphData {
  const linksById = new Map<string, GraphLink>();

  for (const link of current.links) {
    linksById.set(link.id, {
      ...link,
      source: endpointId(link.source),
      target: endpointId(link.target),
    });
  }

  const nodesById = new Map<string, GraphNode>(
    current.nodes.map((node) => [node.id, { ...node }])
  );

  function ensureNode(id: string) {
    if (!nodesById.has(id)) {
      nodesById.set(id, {
        id,
        name: accountName(id),
        kind: "account",
        risk: "normal",
        color: "#10b981",
        value: 4,
        transactionCount: 0,
        totalAmount: 0,
      });
    }
  }

  for (const transaction of transactions) {
    const sourceId = transaction.source_account_id;
    const targetId = transaction.destination_account_id;

    if (!sourceId || !targetId) continue;

    ensureNode(sourceId);
    ensureNode(targetId);

    // Do not duplicate transactions already in the graph.
    if (linksById.has(transaction.id)) continue;

    const amount = toNumber(transaction.amount);
    const metadata = transaction.metadata ?? {};

    const modelFlagged =
      transaction.predicted_is_fraud === true;

    const groundTruthDemo =
      metadata.dataset === "PaySim" &&
      String(metadata.ground_truth_is_fraud) === "1";

    const transactionType =
      transaction.transaction_type ?? "UNKNOWN";

    linksById.set(transaction.id, {
      id: transaction.id,
      source: sourceId,
      target: targetId,
      label: `${transactionType} · ${formatAmount(amount)} · History`,
      amount,
      transactionType,
      transactionStep: transaction.transaction_step,
      modelScore:
        transaction.model_score === null
          ? null
          : toNumber(transaction.model_score),
      predictedIsFraud: modelFlagged,
      groundTruthDemo,
      // History links are extra graph edges, not CTE hop numbers.
      hop: 0,
      inSuspiciousModelPath: false,
      inPaySimDemoPath: false,
      pathCount: 0,
    });
  }

  const links = Array.from(linksById.values());

  const modelFlaggedAccounts = new Set<string>();
  const demoFlaggedAccounts = new Set<string>();

  for (const node of nodesById.values()) {
    if (node.risk === "model_flagged") {
      modelFlaggedAccounts.add(node.id);
    } else if (node.risk === "ground_truth_demo") {
      demoFlaggedAccounts.add(node.id);
    }
  }

  const counts = new Map<string, number>();
  const totals = new Map<string, number>();

  for (const link of links) {
    const sourceId = endpointId(link.source);
    const targetId = endpointId(link.target);

    ensureNode(sourceId);
    ensureNode(targetId);

    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);

    totals.set(
      sourceId,
      (totals.get(sourceId) ?? 0) + link.amount
    );

    totals.set(
      targetId,
      (totals.get(targetId) ?? 0) + link.amount
    );

    if (link.predictedIsFraud) {
      modelFlaggedAccounts.add(sourceId);
      modelFlaggedAccounts.add(targetId);
    }

    if (link.groundTruthDemo) {
      demoFlaggedAccounts.add(sourceId);
      demoFlaggedAccounts.add(targetId);
    }
  }

  const nodes = Array.from(nodesById.values()).map((node) => {
    const risk = riskFromFlags(
      modelFlaggedAccounts.has(node.id),
      demoFlaggedAccounts.has(node.id)
    );

    const transactionCount = counts.get(node.id) ?? 0;

    return {
      ...node,
      risk,
      color: riskColor(risk),
      transactionCount,
      totalAmount: totals.get(node.id) ?? 0,
      value: Math.max(
        4,
        Math.min(12, 4 + Math.sqrt(transactionCount) * 2)
      ),
    };
  });

  return { nodes, links };
}

export default function TransactionNetwork() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  const fitTimerRef = useRef<number | null>(null);
  const historyRequestRef = useRef(0);

  const [graphWidth, setGraphWidth] = useState(900);

  const [graphData, setGraphData] = useState<GraphData>({
    nodes: [],
    links: [],
  });

  const [stats, setStats] =
    useState<NetworkStats>(EMPTY_STATS);

  const [twoHopPaths, setTwoHopPaths] =
    useState<TwoHopPath[]>([]);

  const [selectedNode, setSelectedNode] =
    useState<GraphNode | null>(null);

  const [selectedPathId, setSelectedPathId] = useState("");

  const [history, setHistory] =
    useState<AccountTransaction[]>([]);

  const [historyLoadedAccountId, setHistoryLoadedAccountId] =
    useState<string | null>(null);

  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyHasMore, setHistoryHasMore] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadNetwork = useCallback(async () => {
    historyRequestRef.current += 1;

    setLoading(true);
    setError("");
    setHistory([]);
    setHistoryError("");
    setHistoryLoadedAccountId(null);
    setHistoryHasMore(false);
    setHistoryLoading(false);
    setSelectedNode(null);
    setSelectedPathId("");

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) throw sessionError;

      if (!session) {
        setGraphData({ nodes: [], links: [] });
        setTwoHopPaths([]);
        throw new Error(
          "Please sign in to view the transaction network."
        );
      }

      const response = await fetch("/api/network", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      const result = (await response.json()) as NetworkResponse;

      if (!response.ok) {
        throw new Error(
          result.error ?? "Failed to load transaction network."
        );
      }

      const rawNodes = result.nodes ?? [];
      const rawLinks = result.links ?? [];

      const degree = new Map<string, number>();
      const totals = new Map<string, number>();

      for (const link of rawLinks) {
        const amount = toNumber(link.amount);

        degree.set(
          link.source,
          (degree.get(link.source) ?? 0) + 1
        );
        degree.set(
          link.target,
          (degree.get(link.target) ?? 0) + 1
        );

        totals.set(
          link.source,
          (totals.get(link.source) ?? 0) + amount
        );
        totals.set(
          link.target,
          (totals.get(link.target) ?? 0) + amount
        );
      }

      const nodes: GraphNode[] = rawNodes.map((node) => {
        const risk =
          node.risk_level ??
          riskFromFlags(
            node.model_flagged,
            node.ground_truth_demo
          );

        const count = degree.get(node.id) ?? 0;

        return {
          id: node.id,
          name: node.name || accountName(node.id),
          kind: "account",
          risk,
          color: riskColor(risk),
          value: Math.max(
            4,
            Math.min(12, 4 + Math.sqrt(count) * 2)
          ),
          transactionCount: count,
          totalAmount: totals.get(node.id) ?? 0,
        };
      });

      const nodeIds = new Set(nodes.map((node) => node.id));

      const links: GraphLink[] = rawLinks
        .filter(
          (link) =>
            nodeIds.has(link.source) &&
            nodeIds.has(link.target)
        )
        .map((link) => {
          const amount = toNumber(link.amount);
          const transactionType =
            link.transaction_type ?? link.type ?? "UNKNOWN";

          return {
            id: link.id,
            source: link.source,
            target: link.target,
            label: `${transactionType} · ${formatAmount(amount)} · Hop ${link.hop}`,
            amount,
            transactionType,
            transactionStep: link.transaction_step,
            modelScore:
              link.model_score === null
                ? null
                : toNumber(link.model_score),
            predictedIsFraud: link.model_flagged === true,
            groundTruthDemo: link.ground_truth_demo === true,
            hop: link.hop,
            inSuspiciousModelPath:
              link.in_suspicious_model_path === true,
            inPaySimDemoPath:
              link.in_paysim_demo_path === true,
            pathCount: link.path_count ?? 0,
          };
        });

      const paths = result.twoHopPaths ?? [];
      const apiStats = result.stats ?? {};

      setGraphData({ nodes, links });
      setTwoHopPaths(paths);
      setStats({
        transactionsIncluded: apiStats.link_count ?? links.length,
        modelFlaggedTransactions:
          apiStats.model_flagged_transactions ??
          links.filter((link) => link.predictedIsFraud).length,
        groundTruthDemoTransactions:
          apiStats.paysim_demo_transactions ??
          links.filter((link) => link.groundTruthDemo).length,
        totalTwoHopPaths: apiStats.total_two_hop_paths ?? paths.length,
        unflaggedTwoHopPaths:
          apiStats.unflagged_two_hop_paths ?? 0,
        suspiciousTwoHopPaths:
          apiStats.suspicious_two_hop_paths ?? 0,
        paysimDemoTwoHopPaths:
          apiStats.paysim_demo_two_hop_paths ?? 0,
        maxHop: apiStats.max_hop ?? 0,
      });

      setSelectedPathId(paths[0]?.id ?? "");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load transaction network."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch one page of transaction history for an account.
  const loadAccountHistory = useCallback(
    async (accountId: string, append = false) => {
      const requestId = ++historyRequestRef.current;
      const offset = append ? history.length : 0;

      setHistoryLoading(true);
      setHistoryError("");

      if (!append) {
        setHistory([]);
        setHistoryLoadedAccountId(null);
        setHistoryHasMore(false);
      }

      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) throw sessionError;

        if (!session) {
          throw new Error(
            "Please sign in again to load transaction history."
          );
        }

        const query = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });

        const response = await fetch(
          `/api/network/accounts/${encodeURIComponent(accountId)}/transactions?${query.toString()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          }
        );

        const result = (await response.json()) as HistoryResponse;

        if (!response.ok) {
          throw new Error(
            result.error ??
              "Could not load this account's transaction history."
          );
        }

        // Ignore older requests if the user selected another node.
        if (requestId !== historyRequestRef.current) return;

        const transactions = result.transactions ?? [];

        setHistory((current) => {
          if (!append) return transactions;

          const merged = new Map(
            current.map((transaction) => [
              transaction.id,
              transaction,
            ])
          );

          for (const transaction of transactions) {
            merged.set(transaction.id, transaction);
          }

          return Array.from(merged.values());
        });

        setHistoryLoadedAccountId(accountId);
        setHistoryHasMore(result.stats?.hasMore ?? false);

        // Merge newly fetched links and accounts into the visible graph.
        setGraphData((current) =>
          mergeHistoryIntoGraph(current, transactions)
        );
      } catch (err) {
        if (requestId !== historyRequestRef.current) return;

        setHistoryError(
          err instanceof Error
            ? err.message
            : "Unable to load transaction history."
        );
      } finally {
        if (requestId === historyRequestRef.current) {
          setHistoryLoading(false);
        }
      }
    },
    [history.length]
  );

  const handleNodeClick = useCallback(
    (rawNode: object) => {
      const node = rawNode as GraphNode;

      setSelectedNode(node);
      setSelectedPathId("");
      void loadAccountHistory(node.id, false);
    },
    [loadAccountHistory]
  );

  useEffect(() => {
    void loadNetwork();
  }, [loadNetwork]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      const width = container.clientWidth;
      if (width > 0) setGraphWidth(Math.max(320, width));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      historyRequestRef.current += 1;

      if (fitTimerRef.current !== null) {
        window.clearTimeout(fitTimerRef.current);
      }
    };
  }, []);

  // Keep metrics accurate as history adds new edges.
  useEffect(() => {
    setStats((current) => ({
      ...current,
      transactionsIncluded: graphData.links.length,
      modelFlaggedTransactions: graphData.links.filter(
        (link) => link.predictedIsFraud
      ).length,
      groundTruthDemoTransactions: graphData.links.filter(
        (link) => link.groundTruthDemo
      ).length,
    }));
  }, [graphData.links]);

  const handleEngineStop = useCallback(() => {
    if (fitTimerRef.current !== null) {
      window.clearTimeout(fitTimerRef.current);
    }

    fitTimerRef.current = window.setTimeout(() => {
      graphRef.current?.zoomToFit(500, 70);
      fitTimerRef.current = null;
    }, 100);
  }, []);

  const selectedPath = useMemo(
    () =>
      twoHopPaths.find((path) => path.id === selectedPathId) ??
      null,
    [twoHopPaths, selectedPathId]
  );

  const selectedTransactionIds = useMemo(
    () => new Set(selectedPath?.transaction_ids ?? []),
    [selectedPath]
  );

  const nodeNames = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node.name])),
    [graphData.nodes]
  );

  const selectedPathTransactions = useMemo(
    () =>
      selectedPath
        ? selectedPath.transaction_ids
            .map((id) => graphData.links.find((link) => link.id === id))
            .filter((link): link is GraphLink => Boolean(link))
        : [],
    [selectedPath, graphData.links]
  );

  const selectedHistoryIsCurrent =
    !!selectedNode &&
    historyLoadedAccountId === selectedNode.id;

  const selectedHistory = useMemo(
    () =>
      selectedNode
        ? history.filter(
            (transaction) =>
              transaction.source_account_id === selectedNode.id ||
              transaction.destination_account_id === selectedNode.id
          )
        : [],
    [history, selectedNode]
  );

  const linkColor = useCallback(
    (rawLink: object) => {
      const link = rawLink as GraphLink;

      if (selectedTransactionIds.has(link.id)) return "#22d3ee";
      if (link.inSuspiciousModelPath) return "#ef4444";
      if (link.inPaySimDemoPath) return "#f59e0b";

      return link.hop === 2 ? "#64748b" : "#475569";
    },
    [selectedTransactionIds]
  );

  const linkWidth = useCallback(
    (rawLink: object) => {
      const link = rawLink as GraphLink;

      if (selectedTransactionIds.has(link.id)) return 3.5;
      if (
        link.inSuspiciousModelPath ||
        link.inPaySimDemoPath
      ) {
        return 2.5;
      }

      return 1.25;
    },
    [selectedTransactionIds]
  );

  const focusPath = useCallback(
    (pathId: string) => {
      setSelectedPathId(pathId);
      setSelectedNode(null);

      const path = twoHopPaths.find(
        (candidate) => candidate.id === pathId
      );

      if (!path) return;

      const middle = graphData.nodes.find(
        (node) => node.id === path.intermediary
      );

      if (middle) {
        graphRef.current?.centerAt(
          middle.x ?? 0,
          middle.y ?? 0,
          500
        );
        graphRef.current?.zoom(2, 500);
      }
    },
    [twoHopPaths, graphData.nodes]
  );

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 p-5">
        <div>
          <h2 className="text-xl font-semibold text-white">
            Transaction Network
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Click any account to fetch its transaction history and expand the graph.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium tracking-wide text-emerald-300">
            LIVE SUPABASE QUERY
          </span>

          <button
            type="button"
            onClick={() => void loadNetwork()}
            disabled={loading}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>

          <button
            type="button"
            onClick={() => graphRef.current?.zoomToFit(500, 70)}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Fit graph
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 border-b border-slate-800 p-4 lg:grid-cols-4">
        <Metric label="Transactions displayed" value={stats.transactionsIncluded} />
        <Metric label="Two-hop paths" value={stats.totalTwoHopPaths} color="text-cyan-300" />
        <Metric label="Model-flagged transactions" value={stats.modelFlaggedTransactions} color="text-red-400" />
        <Metric label="PaySim demo labels" value={stats.groundTruthDemoTransactions} color="text-amber-300" />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-800 px-5 py-3 text-xs text-slate-400">
        {[
          { label: "Normal account", color: "#10b981" },
          { label: "Model-flagged", color: "#ef4444" },
          { label: "PaySim demo label", color: "#f59e0b" },
          { label: "Selected path", color: "#22d3ee" },
        ].map((item) => (
          <span key={item.label} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>

      {error && (
        <div role="alert" className="m-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex h-[460px] items-center justify-center text-sm text-slate-400">
          Loading transaction network...
        </div>
      ) : graphData.nodes.length === 0 ? (
        <div className="flex h-[300px] items-center justify-center px-5 text-center text-sm text-slate-400">
          No linked transaction relationships are available in this sample.
        </div>
      ) : (
        <>
          <div ref={containerRef} className="w-full overflow-hidden">
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData}
              width={graphWidth}
              height={460}
              backgroundColor="#020617"
              nodeId="id"
              nodeLabel={(rawNode) => {
                const node = rawNode as unknown as GraphNode;

                return [
                  node.name,
                  `Account ID: ${node.id}`,
                  `Risk: ${riskLabel(node.risk)}`,
                  `Connected transactions: ${node.transactionCount}`,
                  `Activity amount: ${formatAmount(node.totalAmount)}`,
                ].join("\n");
              }}
              nodeColor={(node) =>
                (node as unknown as GraphNode).color
              }
              nodeVal={(node) =>
                (node as unknown as GraphNode).value
              }
              nodeRelSize={4}
              linkLabel="label"
              linkColor={(link) => linkColor(link as object)}
              linkWidth={(link) => linkWidth(link as object)}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowColor={(link) => linkColor(link as object)}
              linkDirectionalArrowRelPos={0.9}
              warmupTicks={50}
              cooldownTicks={150}
              onEngineStop={handleEngineStop}
              onNodeClick={handleNodeClick}
              onLinkClick={(rawLink) => {
                const link = rawLink as unknown as GraphLink;

                const matchingPath = twoHopPaths.find(
                  (path) =>
                    path.transaction_ids.includes(link.id)
                );

                if (matchingPath) focusPath(matchingPath.id);
              }}
            />
          </div>

          {/* Two-hop investigation */}
          <div className="border-t border-slate-800 p-5">
            <h3 className="font-semibold text-white">
              Two-Hop Path Investigation
            </h3>
            <p className="mt-1 text-sm text-slate-400">
              Select a connected path to highlight its two transactions.
            </p>

            {twoHopPaths.length === 0 ? (
              <p className="mt-3 rounded-lg border border-slate-800 p-4 text-sm text-slate-400">
                No two-hop paths are available in the current sample.
              </p>
            ) : (
              <select
                aria-label="Select two-hop path"
                value={selectedPathId}
                onChange={(event) => focusPath(event.target.value)}
                className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-sm text-white"
              >
                <option value="">Choose a path...</option>
                {twoHopPaths.map((path, index) => (
                  <option key={path.id} value={path.id}>
                    Path {index + 1}:{" "}
                    {nodeNames.get(path.source) ?? accountName(path.source)}
                    {" → "}
                    {nodeNames.get(path.intermediary) ?? accountName(path.intermediary)}
                    {" → "}
                    {nodeNames.get(path.destination) ?? accountName(path.destination)}
                    {" · "}
                    {pathLabel(path.classification)}
                  </option>
                ))}
              </select>
            )}

            {selectedPath && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
                <span className={`rounded-md border px-2.5 py-1 text-xs ${pathClasses(selectedPath.classification)}`}>
                  {pathLabel(selectedPath.classification)}
                </span>

                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {[
                    { label: "Source", id: selectedPath.source },
                    { label: "Intermediary", id: selectedPath.intermediary },
                    { label: "Destination", id: selectedPath.destination },
                  ].map((account) => (
                    <div key={account.label} className="rounded-lg border border-slate-800 p-3">
                      <p className="text-xs text-slate-500">{account.label}</p>
                      <p className="mt-1 text-sm text-slate-200">
                        {nodeNames.get(account.id) ?? accountName(account.id)}
                      </p>
                      <p className="mt-1 break-all text-xs text-slate-500">
                        {account.id}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          const node = graphData.nodes.find(
                            (item) => item.id === account.id
                          );
                          if (node) handleNodeClick(node);
                        }}
                        className="mt-2 text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        Fetch account history
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 space-y-2">
                  {selectedPathTransactions.map((transaction) => (
                    <div key={transaction.id} className="rounded-lg border border-slate-800 p-3">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-sm text-slate-200">
                          {transaction.transactionType}
                        </span>
                        <span className="text-sm font-medium text-cyan-300">
                          {formatAmount(transaction.amount)}
                        </span>
                      </div>
                      <p className="mt-1 break-all text-xs text-slate-500">
                        Transaction ID: {transaction.id}
                      </p>
                    </div>
                  ))}
                </div>

                <p className="mt-3 text-xs leading-5 text-slate-500">
                  {selectedPath.classification === "unflagged"
                    ? "This path has no recorded model fraud flag or PaySim ground-truth fraud label in the returned sample."
                    : selectedPath.classification === "model_flagged"
                      ? "At least one transaction has a positive stored model prediction."
                      : "At least one transaction has a PaySim demonstration fraud label, not a live model prediction."}
                </p>
              </div>
            )}
          </div>

          {/* Selected account and its live history */}
          <div className="border-t border-slate-800 p-5">
            {selectedNode ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">
                      Selected account
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-white">
                      {selectedNode.name}
                    </h3>
                    <p className="mt-1 break-all text-xs text-slate-400">
                      ID: {selectedNode.id}
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      {selectedNode.transactionCount} connected graph transactions
                      {" · "}
                      Activity amount: {formatAmount(selectedNode.totalAmount)}
                    </p>
                  </div>

                  <span className={`rounded-md border px-3 py-1.5 text-xs ${
                    selectedNode.risk === "model_flagged"
                      ? "border-red-500/40 bg-red-500/10 text-red-300"
                      : selectedNode.risk === "ground_truth_demo"
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  }`}>
                    {riskLabel(selectedNode.risk)}
                  </span>
                </div>

                <div className="mt-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h4 className="font-semibold text-white">
                      Live transaction history
                    </h4>
                    {historyLoadedAccountId === selectedNode.id && (
                      <span className="text-xs text-slate-400">
                        {history.length} records loaded
                      </span>
                    )}
                  </div>

                  {historyLoading && (
                    <div role="status" className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-4 text-sm text-cyan-200">
                      Fetching transactions from Supabase and expanding the graph...
                    </div>
                  )}

                  {historyError && (
                    <div role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                      <p className="text-sm text-red-300">{historyError}</p>
                      <button
                        type="button"
                        disabled={historyLoading}
                        onClick={() => void loadAccountHistory(selectedNode.id)}
                        className="mt-3 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Retry history request
                      </button>
                    </div>
                  )}

                  {!historyLoading &&
                    !historyError &&
                    selectedHistoryIsCurrent &&
                    selectedHistory.length === 0 && (
                      <div className="mt-3 rounded-lg border border-slate-800 p-4">
                        <p className="text-sm text-slate-300">
                          No transactions were found for this account.
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          This result is from the live account-history query.
                        </p>
                      </div>
                    )}

                  {selectedHistoryIsCurrent && selectedHistory.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {selectedHistory.map((transaction) => {
                        const sourceName =
                          nodeNames.get(transaction.source_account_id) ??
                          accountName(transaction.source_account_id);

                        const destinationName =
                          nodeNames.get(transaction.destination_account_id) ??
                          accountName(transaction.destination_account_id);

                        const isModelFlagged =
                          transaction.predicted_is_fraud === true;

                        const metadata = transaction.metadata ?? {};

                        const isPaySimDemo =
                          metadata.dataset === "PaySim" &&
                          String(metadata.ground_truth_is_fraud) === "1";

                        return (
                          <article
                            key={transaction.id}
                            className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-200">
                                  {sourceName} → {destinationName}
                                </p>
                                <p className="mt-1 text-xs text-slate-400">
                                  {transaction.transaction_type ?? "UNKNOWN"}
                                  {" · Step "}
                                  {transaction.transaction_step ?? "N/A"}
                                </p>
                              </div>
                              <span className="text-sm font-semibold text-cyan-300">
                                {transaction.amount === null
                                  ? "Amount unavailable"
                                  : formatAmount(transaction.amount)}
                              </span>
                            </div>

                            <p className="mt-2 break-all text-xs text-slate-500">
                              Transaction ID: {transaction.id}
                            </p>

                            <div className="mt-2 flex flex-wrap gap-2">
                              {isModelFlagged && (
                                <span className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-300">
                                  Model flagged
                                </span>
                              )}
                              {isPaySimDemo && (
                                <span className="rounded border border-amber-500/30 px-2 py-1 text-xs text-amber-300">
                                  PaySim demo label
                                </span>
                              )}
                              {!isModelFlagged && !isPaySimDemo && (
                                <span className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400">
                                  No fraud flag recorded
                                </span>
                              )}
                              <span className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400">
                                Model score:{" "}
                                {transaction.model_score === null
                                  ? "Not available"
                                  : transaction.model_score.toFixed(4)}
                              </span>
                            </div>
                          </article>
                        );
                      })}

                      {historyHasMore && (
                        <button
                          type="button"
                          disabled={historyLoading}
                          onClick={() =>
                            void loadAccountHistory(selectedNode.id, true)
                          }
                          className="w-full rounded-lg border border-slate-700 px-3 py-3 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                        >
                          {historyLoading
                            ? "Loading more..."
                            : "Load more transactions"}
                        </button>
                      )}

                      {historyHasMore && (
                        <p className="text-xs text-slate-500">
                          More transactions may be available for this account.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    historyRequestRef.current += 1;
                    setSelectedNode(null);
                    setHistory([]);
                    setHistoryLoadedAccountId(null);
                    setHistoryError("");
                    setHistoryLoading(false);
                    setHistoryHasMore(false);
                  }}
                  className="mt-4 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Clear account selection
                </button>
              </>
            ) : (
              <p className="text-sm text-slate-400">
                Click any account node to fetch its transaction history
                and add new account connections to the graph.
              </p>
            )}
          </div>
        </>
      )}

      <footer className="border-t border-slate-800 px-5 py-3">
        <p className="text-xs leading-5 text-slate-500">
          The initial graph uses a bounded database sample. Selecting an account
          fetches additional transactions from Supabase and adds new connections
          to the graph. Red indicates a positive recorded model prediction;
          amber indicates a PaySim ground-truth demonstration label. A PaySim
          label is not a live ML prediction, and an unflagged path is not
          classified as confirmed fraud.
        </p>
      </footer>
    </section>
  );
}

function Metric({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>
        {value}
      </p>
    </div>
  );
}
