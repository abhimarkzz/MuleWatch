"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ForceGraphMethods } from "react-force-graph-2d";
import { ApiError, apiRequest, errorMessage, isAbort } from "@/lib/api-client";
import { accountLabel, formatAmount, formatProbability, shortId } from "@/lib/format";
import { Button, cx, EmptyState, Icon, Mono, Notice, PageHeader, Panel, Spinner } from "@/components/ui";
import {
  countNewAccounts,
  EMPTY_GRAPH,
  endpointId,
  graphFromNetwork,
  MAX_GRAPH_NODES,
  mergeHistory,
  type Graph,
  type GraphLink,
  type GraphNode,
  type HistoryResponse,
  type HistoryTransaction,
  type NetworkResponse,
  type TwoHopPath,
} from "./graph-model";

// Canvas-only library: load on the client. The cast restores the generic
// props that next/dynamic erases.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => <GraphPlaceholder label="Preparing the graph canvas…" />,
}) as unknown as typeof import("react-force-graph-2d").default;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_PAGE = 50;

// Canvas cannot read CSS variables cheaply on every frame; mirror the tokens.
const C = {
  node: "#7d838a",
  modelFlag: "#a63d0c",
  truth: "#6236b0",
  accent: "#1d4f7c",
  edge: "#bdbab0",
  ink: "#1b1e21",
  surface: "#ffffff",
};

type Selection = { kind: "account"; id: string } | { kind: "path"; id: string } | null;

type HistoryEntry = {
  status: "loading" | "ready" | "error";
  transactions: HistoryTransaction[];
  hasMore: boolean;
  error?: string;
};

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

export function NetworkExplorer() {
  const searchParams = useSearchParams();
  const focusAccount = searchParams.get("account");

  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitPendingRef = useRef(true);
  // Until the analyst pans, zooms or clicks the canvas, keep the graph fitted.
  const interactedRef = useRef(false);
  const historyControllers = useRef(new Map<string, AbortController>());
  const networkController = useRef<AbortController | null>(null);

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
  const [paths, setPaths] = useState<TwoHopPath[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [history, setHistory] = useState<Record<string, HistoryEntry>>({});
  const [capNotice, setCapNotice] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [tab, setTab] = useState<"paths" | "transactions">("paths");

  // Async callbacks read the latest graph without re-subscribing.
  const graphRefState = useRef(graph);
  useEffect(() => {
    graphRefState.current = graph;
  }, [graph]);

  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const fetchHistory = useCallback(async (accountId: string, offset = 0) => {
    // One request per account at a time; repeat clicks reuse the cache.
    if (historyControllers.current.has(accountId)) return;
    const controller = new AbortController();
    historyControllers.current.set(accountId, controller);

    setHistory((current) => ({
      ...current,
      [accountId]: {
        status: "loading",
        transactions: current[accountId]?.transactions ?? [],
        hasMore: current[accountId]?.hasMore ?? false,
      },
    }));

    try {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE), offset: String(offset) });
      const result = await apiRequest<HistoryResponse>(
        `/api/network/accounts/${encodeURIComponent(accountId)}/transactions?${params}`,
        { signal: controller.signal }
      );
      const transactions = Array.isArray(result.transactions) ? result.transactions : [];

      const added = countNewAccounts(graphRefState.current, transactions);
      const projected = graphRefState.current.nodes.length + added;

      if (projected > MAX_GRAPH_NODES) {
        setCapNotice(
          `Expanding ${accountLabel(accountId)} would add ${added} accounts and exceed the ${MAX_GRAPH_NODES}-account display limit. Its history is listed in the inspector but not drawn.`
        );
      } else {
        setGraph((current) => mergeHistory(current, transactions, accountId));
      }

      setHistory((current) => {
        const previous = offset > 0 ? (current[accountId]?.transactions ?? []) : [];
        const byId = new Map(previous.map((transaction) => [transaction.id, transaction]));
        for (const transaction of transactions) byId.set(transaction.id, transaction);
        return {
          ...current,
          [accountId]: { status: "ready", transactions: [...byId.values()], hasMore: result.stats?.hasMore === true },
        };
      });
    } catch (error) {
      if (isAbort(error)) return;
      setHistory((current) => ({
        ...current,
        [accountId]: {
          status: "error",
          transactions: current[accountId]?.transactions ?? [],
          hasMore: current[accountId]?.hasMore ?? false,
          error: errorMessage(error, "History could not be loaded."),
        },
      }));
    } finally {
      historyControllers.current.delete(accountId);
    }
  }, []);

  const loadNetwork = useCallback(async () => {
    networkController.current?.abort();
    for (const controller of historyControllers.current.values()) controller.abort();
    historyControllers.current.clear();

    const controller = new AbortController();
    networkController.current = controller;
    setLoad({ kind: "loading" });
    setSelection(null);
    setHistory({});
    setCapNotice(null);

    try {
      const result = await apiRequest<NetworkResponse>("/api/network", { signal: controller.signal });
      fitPendingRef.current = true;
      interactedRef.current = false;
      setGraph(graphFromNetwork(result));
      setPaths(Array.isArray(result.twoHopPaths) ? result.twoHopPaths : []);
      setLoad({ kind: "ready" });
    } catch (error) {
      if (isAbort(error)) return;
      setLoad({
        kind: "error",
        message:
          error instanceof ApiError && error.status === 500
            ? `${error.message} The recursive query function may not be installed in this Supabase project.`
            : errorMessage(error, "The network could not be loaded."),
      });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadNetwork(), 0);
    const controllers = historyControllers.current;
    return () => {
      window.clearTimeout(timer);
      networkController.current?.abort();
      for (const controller of controllers.values()) controller.abort();
    };
  }, [loadNetwork]);

  // Deep link from the alert drawer: /network?account=<uuid>
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (load.kind !== "ready" || !focusAccount || handledFocus.current === focusAccount) return;
    handledFocus.current = focusAccount;
    if (!UUID.test(focusAccount)) return;
    const timer = window.setTimeout(() => {
      setSelection({ kind: "account", id: focusAccount });
      void fetchHistory(focusAccount);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load.kind, focusAccount, fetchHistory]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(280, Math.floor(entry.contentRect.width));
      setSize({ width, height: width < 640 ? 380 : 520 });
      if (!interactedRef.current) window.setTimeout(() => graphRef.current?.zoomToFit(0, 40), 50);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [load.kind]);

  const selectedPath = selection?.kind === "path" ? (paths.find((path) => path.id === selection.id) ?? null) : null;
  const selectedAccount = selection?.kind === "account" ? selection.id : null;

  const highlighted = useMemo(() => {
    const links = new Set<string>(selectedPath?.transaction_ids ?? []);
    const nodes = new Set<string>(
      selectedPath ? [selectedPath.source, selectedPath.intermediary, selectedPath.destination] : []
    );

    if (selectedAccount) {
      nodes.add(selectedAccount);
      for (const link of graph.links) {
        const s = endpointId(link.source);
        const t = endpointId(link.target);
        if (s === selectedAccount || t === selectedAccount) {
          links.add(link.id);
          nodes.add(s);
          nodes.add(t);
        }
      }
    }

    return { links, nodes, active: links.size > 0 || nodes.size > 0 };
  }, [selectedPath, selectedAccount, graph.links]);

  const stats = useMemo(
    () => ({
      accounts: graph.nodes.length,
      transactions: graph.links.length,
      modelFlagged: graph.links.filter((link) => link.modelFlagged).length,
      paySim: graph.links.filter((link) => link.paySimLabel).length,
    }),
    [graph]
  );

  const centerOn = useCallback((ids: string[]) => {
    const points = ids
      .map((id) => graphRefState.current.nodes.find((node) => node.id === id))
      .filter((node): node is GraphNode => node?.x !== undefined && node?.y !== undefined);
    if (points.length === 0) return;
    const x = points.reduce((sum, node) => sum + node.x!, 0) / points.length;
    const y = points.reduce((sum, node) => sum + node.y!, 0) / points.length;
    graphRef.current?.centerAt(x, y, 400);
    graphRef.current?.zoom(Math.max(graphRef.current?.zoom() ?? 1, 2), 400);
  }, []);

  const selectAccount = useCallback(
    (id: string, { center = false } = {}) => {
      setSelection({ kind: "account", id });
      if (!history[id] || history[id].status === "error") void fetchHistory(id);
      if (center) centerOn([id]);
    },
    [history, fetchHistory, centerOn]
  );

  const selectPath = useCallback(
    (path: TwoHopPath) => {
      setSelection({ kind: "path", id: path.id });
      centerOn([path.source, path.intermediary, path.destination]);
    },
    [centerOn]
  );

  const drawNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, scale: number) => {
      if (node.x === undefined || node.y === undefined) return;
      const radius = 3 + Math.min(6, Math.sqrt(node.degree) * 1.4);
      const dimmed = highlighted.active && !highlighted.nodes.has(node.id);
      const selected = node.id === selectedAccount;
      const expanded = history[node.id]?.status === "ready";

      ctx.globalAlpha = dimmed ? 0.25 : 1;

      // Model-flag association is drawn as a diamond so it reads without colour.
      ctx.beginPath();
      if (node.linkedToModelFlag) {
        const r = radius * 1.25;
        ctx.moveTo(node.x, node.y - r);
        ctx.lineTo(node.x + r, node.y);
        ctx.lineTo(node.x, node.y + r);
        ctx.lineTo(node.x - r, node.y);
        ctx.closePath();
      } else {
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      }
      ctx.fillStyle = node.linkedToModelFlag ? C.modelFlag : C.node;
      ctx.fill();

      // PaySim-label association: dashed violet ring.
      if (node.linkedToPaySimLabel) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 3, 0, 2 * Math.PI);
        ctx.setLineDash([2.5, 2]);
        ctx.strokeStyle = C.truth;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (expanded) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, Math.max(1.2, radius * 0.35), 0, 2 * Math.PI);
        ctx.fillStyle = C.surface;
        ctx.fill();
      }

      if (selected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 6, 0, 2 * Math.PI);
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 2.5 / Math.max(scale, 1) + 0.5;
        ctx.stroke();
      }

      if (selected || (scale > 2.2 && !dimmed) || highlighted.nodes.has(node.id)) {
        const fontSize = Math.max(10 / scale, 2.5);
        ctx.font = `500 ${fontSize}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = C.ink;
        ctx.fillText(shortId(node.id), node.x, node.y + radius + 4);
      }

      ctx.globalAlpha = 1;
    },
    [highlighted, selectedAccount, history]
  );

  const paintHitArea = useCallback((node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
    if (node.x === undefined || node.y === undefined) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, 3 + Math.min(6, Math.sqrt(node.degree) * 1.4) + 4, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const linkColor = useCallback(
    (link: GraphLink) => {
      if (highlighted.links.has(link.id)) return C.accent;
      const base = link.modelFlagged ? C.modelFlag : link.paySimLabel ? C.truth : C.edge;
      return highlighted.active ? `${base}40` : base;
    },
    [highlighted]
  );

  const selectedHistory = selectedAccount ? history[selectedAccount] : undefined;

  return (
    <>
      <PageHeader
        title="Network explorer"
        description="Accounts linked by transactions returned from the two-hop recursive query. Select an account to load its history and expand the graph."
        actions={
          <Button size="sm" onClick={() => void loadNetwork()} busy={load.kind === "loading"}>
            {load.kind !== "loading" && <Icon name="refresh" />}
            Reload network
          </Button>
        }
      />

      {load.kind === "error" && (
        <Notice
          tone="danger"
          title="The network could not be loaded"
          action={
            <Button size="sm" onClick={() => void loadNetwork()}>
              Retry
            </Button>
          }
        >
          {load.message}
        </Notice>
      )}

      {load.kind !== "error" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 space-y-4">
            <Panel className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-3 py-2.5 text-xs text-ink-2">
                <Stat label="Accounts" value={stats.accounts} />
                <Stat label="Transactions" value={stats.transactions} />
                <Stat label="Model-flagged" value={stats.modelFlagged} />
                <Stat label="PaySim-labelled" value={stats.paySim} />
                <div className="ml-auto flex gap-1.5">
                  {selection && (
                    <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
                      Clear selection
                    </Button>
                  )}
                  <Button size="sm" onClick={() => graphRef.current?.zoomToFit(400, 40)} disabled={graph.nodes.length === 0}>
                    <Icon name="fit" /> Fit
                  </Button>
                </div>
              </div>

              <div
                ref={containerRef}
                className="relative bg-[#fbfbf9]"
                onPointerDown={() => (interactedRef.current = true)}
                onWheel={() => (interactedRef.current = true)}
              >
                {load.kind === "loading" ? (
                  <GraphPlaceholder label="Running the recursive transaction query…" />
                ) : graph.nodes.length === 0 ? (
                  <EmptyState title="No linked transactions were returned">
                    The two-hop query found no account relationships in the current data.
                  </EmptyState>
                ) : (
                  <>
                    <ForceGraph2D
                      ref={graphRef}
                      graphData={graph}
                      width={size.width}
                      height={size.height}
                      backgroundColor="rgba(0,0,0,0)"
                      nodeId="id"
                      nodeLabel={(node: GraphNode) =>
                        `${node.name}\n${node.degree} transactions loaded${node.linkedToModelFlag ? "\nTouches a model-flagged transaction" : ""}${node.linkedToPaySimLabel ? "\nTouches a PaySim-labelled transaction" : ""}`
                      }
                      nodeCanvasObject={drawNode}
                      nodeCanvasObjectMode={() => "replace"}
                      nodePointerAreaPaint={paintHitArea}
                      linkColor={linkColor}
                      linkWidth={(link: GraphLink) => (highlighted.links.has(link.id) ? 2.5 : link.modelFlagged || link.paySimLabel ? 1.6 : 0.9)}
                      linkLineDash={(link: GraphLink) => (link.paySimLabel && !link.modelFlagged ? [3, 2] : null)}
                      linkDirectionalArrowLength={3.5}
                      linkDirectionalArrowRelPos={0.92}
                      linkDirectionalArrowColor={linkColor}
                      linkLabel={(link: GraphLink) =>
                        `${link.transactionType} · ${formatAmount(link.amount)}${link.modelScore !== null ? ` · model ${formatProbability(link.modelScore)}` : ""}`
                      }
                      warmupTicks={40}
                      cooldownTicks={120}
                      onEngineStop={() => {
                        // Fit once per network load, not after every expansion.
                        if (fitPendingRef.current) {
                          fitPendingRef.current = false;
                          graphRef.current?.zoomToFit(400, 40);
                        }
                      }}
                      onNodeClick={(node: GraphNode) => selectAccount(node.id)}
                      onLinkClick={(link: GraphLink) => selectAccount(endpointId(link.source))}
                      onBackgroundClick={() => setSelection(null)}
                    />
                    {Object.values(history).some((entry) => entry.status === "loading") && (
                      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm" role="status">
                        <Spinner /> Expanding account…
                      </div>
                    )}
                  </>
                )}
              </div>

              <Legend />
            </Panel>

            {capNotice && (
              <Notice tone="warn" action={<Button size="sm" variant="ghost" onClick={() => setCapNotice(null)}>Dismiss</Button>}>
                {capNotice}
              </Notice>
            )}

            {load.kind === "ready" && graph.nodes.length > 0 && (
              <Panel>
                <div role="tablist" aria-label="Graph data" className="flex gap-1 border-b border-line px-2">
                  {(
                    [
                      ["paths", `Two-hop paths (${paths.length})`],
                      ["transactions", `Transactions (${graph.links.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      type="button"
                      aria-selected={tab === key}
                      aria-controls={`panel-${key}`}
                      id={`tab-${key}`}
                      onClick={() => setTab(key)}
                      className={cx(
                        "relative px-3 py-2.5 text-[0.8125rem] font-medium",
                        tab === key ? "text-ink" : "text-ink-3 hover:text-ink"
                      )}
                    >
                      {label}
                      {tab === key && <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 bg-accent" />}
                    </button>
                  ))}
                </div>
                <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                  {tab === "paths" ? (
                    <PathList paths={paths} selectedId={selectedPath?.id ?? null} onSelect={selectPath} />
                  ) : (
                    <TransactionTable links={graph.links} onInspect={(id) => selectAccount(id, { center: true })} />
                  )}
                </div>
              </Panel>
            )}
          </div>

          <aside aria-label="Inspector" className="min-w-0">
            <Panel className="xl:sticky xl:top-20">
              {selectedAccount ? (
                <AccountInspector
                  accountId={selectedAccount}
                  node={nodesById.get(selectedAccount)}
                  entry={selectedHistory}
                  onRetry={() => void fetchHistory(selectedAccount)}
                  onMore={() => void fetchHistory(selectedAccount, selectedHistory?.transactions.length ?? 0)}
                  onInspect={(id) => selectAccount(id, { center: true })}
                />
              ) : selectedPath ? (
                <PathInspector path={selectedPath} links={graph.links} onInspect={(id) => selectAccount(id, { center: true })} />
              ) : (
                <div className="p-4 text-ink-2">
                  <p className="font-medium text-ink">Nothing selected</p>
                  <p className="mt-1">
                    Select an account on the graph, or choose a path or transaction below. The same information is
                    available in the tables for keyboard and screen-reader use.
                  </p>
                </div>
              )}
            </Panel>
          </aside>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span>
      {label} <span className="font-medium tabular-nums text-ink">{value}</span>
    </span>
  );
}

function GraphPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex h-[380px] items-center justify-center gap-2 text-ink-2 sm:h-[520px]" role="status">
      <Spinner /> {label}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-3 py-2.5 text-xs text-ink-2">
      <span className="flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill={C.node} /></svg>
        Account
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden="true"><path d="M6 1 11 6 6 11 1 6Z" fill={C.modelFlag} /></svg>
        Touches a model-flagged transaction
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="3" fill={C.node} />
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={C.truth} strokeWidth="1.3" strokeDasharray="2 1.6" />
        </svg>
        Touches a PaySim-labelled transaction
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" fill={C.node} />
          <circle cx="6" cy="6" r="1.6" fill="white" />
        </svg>
        History loaded
      </span>
      <span className="text-ink-3">Arrows point from sender to receiver. Association is not evidence of fraud.</span>
    </div>
  );
}

const PATH_LABEL: Record<TwoHopPath["classification"], string> = {
  model_flagged: "Contains model flag",
  paysim_demo: "Contains PaySim label",
  unflagged: "No flags",
};

function PathList({
  paths,
  selectedId,
  onSelect,
}: {
  paths: TwoHopPath[];
  selectedId: string | null;
  onSelect: (path: TwoHopPath) => void;
}) {
  if (paths.length === 0) {
    return <EmptyState title="No two-hop paths">No sender → intermediary → receiver chains were found in this result.</EmptyState>;
  }

  return (
    <ul className="max-h-[22rem] divide-y divide-line overflow-y-auto">
      {paths.map((path) => (
        <li key={path.id}>
          <button
            type="button"
            onClick={() => onSelect(path)}
            aria-pressed={selectedId === path.id}
            className={cx("flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-canvas", selectedId === path.id && "bg-accent-soft")}
          >
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.8125rem]">
              {shortId(path.source)}
              <Icon name="arrow-right" className="h-3 w-3 text-ink-3" />
              <span className="font-medium">{shortId(path.intermediary)}</span>
              <Icon name="arrow-right" className="h-3 w-3 text-ink-3" />
              {shortId(path.destination)}
            </span>
            <span
              className={cx(
                "ml-auto text-xs",
                path.classification === "model_flagged" && "text-risk-high",
                path.classification === "paysim_demo" && "text-truth",
                path.classification === "unflagged" && "text-ink-3"
              )}
            >
              {PATH_LABEL[path.classification]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FlagText({ link }: { link: Pick<GraphLink, "modelFlagged" | "paySimLabel"> }) {
  if (!link.modelFlagged && !link.paySimLabel) return <span className="text-ink-3">None</span>;
  return (
    <span className="flex flex-col">
      {link.modelFlagged && <span className="text-risk-high">Model flag</span>}
      {link.paySimLabel && <span className="text-truth">PaySim label</span>}
    </span>
  );
}

function TransactionTable({ links, onInspect }: { links: GraphLink[]; onInspect: (accountId: string) => void }) {
  const th = "px-3 py-2 text-left text-xs font-medium text-ink-3";
  return (
    <div className="max-h-[24rem] overflow-auto">
      <table className="w-full min-w-[40rem] border-collapse text-[0.8125rem]">
        <caption className="sr-only">Transactions currently drawn on the graph</caption>
        <thead className="sticky top-0 bg-surface shadow-[0_1px_0_var(--color-line)]">
          <tr>
            <th scope="col" className={th}>Sender</th>
            <th scope="col" className={th}>Receiver</th>
            <th scope="col" className={th}>Type</th>
            <th scope="col" className={cx(th, "text-right")}>Amount</th>
            <th scope="col" className={th}>Model risk</th>
            <th scope="col" className={th}>Flags</th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.id} className="border-t border-line">
              <td className="px-3 py-2">
                <button type="button" className="font-mono text-accent hover:underline" onClick={() => onInspect(endpointId(link.source))}>
                  {shortId(endpointId(link.source))}
                </button>
              </td>
              <td className="px-3 py-2">
                <button type="button" className="font-mono text-accent hover:underline" onClick={() => onInspect(endpointId(link.target))}>
                  {shortId(endpointId(link.target))}
                </button>
              </td>
              <td className="px-3 py-2 text-ink-2">{link.transactionType}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatAmount(link.amount)}</td>
              <td className="px-3 py-2 tabular-nums">{formatProbability(link.modelScore)}</td>
              <td className="px-3 py-2 text-xs">
                <FlagText link={link} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountInspector({
  accountId,
  node,
  entry,
  onRetry,
  onMore,
  onInspect,
}: {
  accountId: string;
  node: GraphNode | undefined;
  entry: HistoryEntry | undefined;
  onRetry: () => void;
  onMore: () => void;
  onInspect: (id: string) => void;
}) {
  const transactions = entry?.transactions ?? [];

  return (
    <div>
      <div className="border-b border-line p-4">
        <p className="text-xs text-ink-3">Account</p>
        <Mono className="mt-0.5 block break-all">{accountId}</Mono>
        {node && (
          <dl className="mt-3 grid grid-cols-3 gap-2 text-[0.8125rem]">
            <div>
              <dt className="text-xs text-ink-3">Loaded txns</dt>
              <dd className="tabular-nums">{node.degree}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Sent</dt>
              <dd className="tabular-nums">{formatAmount(node.outflow)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Received</dt>
              <dd className="tabular-nums">{formatAmount(node.inflow)}</dd>
            </div>
          </dl>
        )}
        {node && (node.linkedToModelFlag || node.linkedToPaySimLabel) && (
          <p className="mt-3 text-xs text-ink-2">
            This account appears in{" "}
            {[node.linkedToModelFlag && "a model-flagged transaction", node.linkedToPaySimLabel && "a PaySim-labelled transaction"]
              .filter(Boolean)
              .join(" and ")}
            . That is an association to investigate, not a finding about the account.
          </p>
        )}
      </div>

      <div className="p-4">
        <p className="text-[0.8125rem] font-semibold">Transaction history</p>

        {entry?.status === "error" && (
          <Notice tone="danger" className="mt-2" action={<Button size="sm" onClick={onRetry}>Retry</Button>}>
            {entry.error}
          </Notice>
        )}

        {entry?.status === "loading" && transactions.length === 0 && (
          <p className="mt-2 flex items-center gap-2 text-ink-2" role="status">
            <Spinner /> Loading history…
          </p>
        )}

        {entry?.status === "ready" && transactions.length === 0 && (
          <p className="mt-2 text-ink-2">No transactions are recorded for this account.</p>
        )}

        {transactions.length > 0 && (
          <ul className="mt-2 max-h-[26rem] divide-y divide-line overflow-y-auto rounded-md border border-line">
            {transactions.map((transaction) => {
              const outgoing = transaction.source_account_id === accountId;
              const counterparty = outgoing ? transaction.destination_account_id : transaction.source_account_id;
              const link = {
                modelFlagged: transaction.predicted_is_fraud === true,
                paySimLabel:
                  transaction.metadata?.dataset === "PaySim" && String(transaction.metadata?.ground_truth_is_fraud) === "1",
              };
              return (
                <li key={transaction.id} className="px-3 py-2 text-[0.8125rem]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-ink-2">
                      {outgoing ? "Sent to" : "Received from"}{" "}
                      {counterparty ? (
                        <button type="button" onClick={() => onInspect(counterparty)} className="font-mono text-accent hover:underline">
                          {shortId(counterparty)}
                        </button>
                      ) : (
                        "unknown"
                      )}
                    </span>
                    <span className="tabular-nums">{formatAmount(transaction.amount)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                    <span>
                      {transaction.transaction_type ?? "UNKNOWN"} · step {transaction.transaction_step ?? "—"} · model{" "}
                      {formatProbability(transaction.model_score)}
                    </span>
                    <FlagText link={link} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {entry?.hasMore && (
          <Button size="sm" className="mt-2 w-full" onClick={onMore} busy={entry.status === "loading"}>
            Load {HISTORY_PAGE} more
          </Button>
        )}
      </div>
    </div>
  );
}

function PathInspector({
  path,
  links,
  onInspect,
}: {
  path: TwoHopPath;
  links: GraphLink[];
  onInspect: (id: string) => void;
}) {
  const steps = path.transaction_ids
    .map((id) => links.find((link) => link.id === id))
    .filter((link): link is GraphLink => Boolean(link));

  return (
    <div className="p-4">
      <p className="text-xs text-ink-3">Two-hop path</p>
      <p className="mt-0.5 font-medium">{PATH_LABEL[path.classification]}</p>

      <ol className="mt-3 space-y-2">
        {(
          [
            ["Sender", path.source],
            ["Intermediary", path.intermediary],
            ["Receiver", path.destination],
          ] as const
        ).map(([role, id], index) => (
          <li key={role}>
            <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs text-ink-3">{role}</p>
                <Mono className="block truncate" >{id}</Mono>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onInspect(id)}>
                Inspect
              </Button>
            </div>
            {steps[index] && index < 2 && (
              <p className="flex items-center gap-2 py-1.5 pl-3 text-xs text-ink-2">
                <Icon name="arrow-right" className="h-3 w-3 rotate-90" />
                {steps[index].transactionType} · {formatAmount(steps[index].amount)} · model {formatProbability(steps[index].modelScore)}
                <FlagText link={steps[index]} />
              </p>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-3">
        A chain where money moves through an intermediary within the query depth. Pass-through patterns are a common
        mule signal, but most chains in PaySim are ordinary.
      </p>
    </div>
  );
}
