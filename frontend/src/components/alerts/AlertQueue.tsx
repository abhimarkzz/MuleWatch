"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { apiRequest, errorMessage, isAbort, ApiError } from "@/lib/api-client";
import { formatAmount, formatProbability, formatTimestamp, shortId } from "@/lib/format";
import { asSeverity, asStatus, SEVERITY_LABEL, SEVERITY_ORDER } from "@/lib/risk";
import {
  alertScore,
  DEFAULT_FILTERS,
  PAGE_SIZE,
  parseFilters,
  serializeFilters,
  type QueueFilters,
} from "@/lib/alert-filters";
import {
  Button,
  cx,
  EmptyState,
  Icon,
  inputClass,
  Mono,
  Notice,
  PageHeader,
  Panel,
  SeverityBadge,
  Skeleton,
  SourceBadge,
  StatusBadge,
} from "@/components/ui";
import { AlertDrawer } from "./AlertDrawer";
import type { AlertRecord, AlertsResponse } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "ready"; result: AlertsResponse; requestedPage: number; loadedAt: Date };

export function AlertQueue() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  // Canonical query string: the request key for this page of results.
  const queryKey = serializeFilters(filters);

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [fetching, setFetching] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // The drawer holds the alert itself so it stays open if the row leaves the page.
  const [selected, setSelected] = useState<AlertRecord | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  // Last header summary and the reload it belongs to; paging reuses it.
  const summaryRef = useRef<{ token: number; value: NonNullable<AlertsResponse["summary"]> } | null>(null);

  useEffect(() => {
    // Each filter change or reload cancels the previous request, so a slow
    // older response can never replace a newer page.
    const controller = new AbortController();
    const requestedPage = parseFilters(new URLSearchParams(queryKey)).page;

    // First load, Refresh and status changes fetch the summary; paging and
    // filtering reuse it, saving two count queries per request.
    const cachedSummary = summaryRef.current?.token === reloadToken ? summaryRef.current.value : null;
    const params = new URLSearchParams(queryKey);
    if (cachedSummary) params.set("summary", "0");

    const run = async () => {
      setFetching(true);
      try {
        const query = params.toString();
        const result = await apiRequest<AlertsResponse>(`/api/alerts${query ? `?${query}` : ""}`, {
          signal: controller.signal,
        });
        const summary = result.summary ?? cachedSummary ?? undefined;
        if (result.summary) summaryRef.current = { token: reloadToken, value: result.summary };
        hasDataRef.current = true;
        setState({
          kind: "ready",
          result: { ...result, summary, alerts: Array.isArray(result.alerts) ? result.alerts : [] },
          requestedPage,
          loadedAt: new Date(),
        });
      } catch (error) {
        if (isAbort(error)) return;
        // A failed refresh keeps the rows already on screen.
        if (hasDataRef.current) {
          setToast(`Could not load alerts: ${errorMessage(error, "unknown error")}`);
        } else {
          setState({
            kind: "error",
            message: errorMessage(error, "Alerts could not be loaded."),
            retryable: !(error instanceof ApiError) || error.retryable,
          });
        }
      } finally {
        if (!controller.signal.aborted) setFetching(false);
      }
    };

    const timer = window.setTimeout(() => void run(), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [queryKey, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const setFilters = useCallback(
    (patch: Partial<QueueFilters>) => {
      const next = { ...filters, page: 1, ...patch };
      const query = serializeFilters(next);
      // Native history update: Next syncs useSearchParams without the server
      // round trip router.replace makes (measured at ~650 ms per page change).
      window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
    },
    [filters, pathname]
  );

  const result = state.kind === "ready" ? state.result : null;

  // The server clamps an out-of-range page; mirror that in the URL. Compare
  // with the page that response was requested for, not the current URL,
  // otherwise a stale response would pull the URL back while paging.
  const clampedPage =
    state.kind === "ready" && state.result.page !== state.requestedPage ? state.result.page : null;
  useEffect(() => {
    if (clampedPage !== null) setFilters({ page: clampedPage });
  }, [clampedPage, setFilters]);

  const rows = result?.alerts ?? [];
  const total = result?.total ?? 0;
  const summary = result?.summary;
  const hasFilters = serializeFilters({ ...filters, page: 1, sort: DEFAULT_FILTERS.sort }) !== "";
  const unresolved = summary ? summary.open + summary.investigating : 0;

  function handleUpdated(id: string, status: string) {
    setSelected((current) => (current && current.id === id && status !== "resolved" ? { ...current, status } : null));
    setToast(`Alert ${shortId(id)} marked ${status}.`);
    // Status affects filters, counts and which page the alert is on.
    reload();
  }

  return (
    <>
      <PageHeader
        title="Alert queue"
        description={
          summary
            ? `${unresolved} unresolved ${unresolved === 1 ? "alert" : "alerts"} — ${summary.open} open, ${summary.investigating} under investigation.`
            : "Unresolved alerts raised by the model or seeded from PaySim labels."
        }
        actions={
          <>
            {state.kind === "ready" && (
              <span className="text-xs text-ink-3">Loaded {formatTimestamp(state.loadedAt.toISOString())}</span>
            )}
            <Button size="sm" onClick={reload} busy={fetching && state.kind === "ready"}>
              {!(fetching && state.kind === "ready") && <Icon name="refresh" />}
              Refresh
            </Button>
          </>
        }
      />

      {toast && (
        <div className="mb-3" aria-live="polite">
          <Notice tone="info">{toast}</Notice>
        </div>
      )}

      <Panel className={cx(fetching && state.kind === "ready" && "opacity-70 transition-opacity")}>
        <FilterBar filters={filters} onChange={setFilters} disabled={state.kind === "loading"} />

        {state.kind === "loading" && <QueueSkeleton />}

        {state.kind === "error" && (
          <div className="p-4">
            <Notice
              tone="danger"
              title="The alert queue could not be loaded"
              action={
                state.retryable && (
                  <Button size="sm" onClick={reload} busy={fetching}>
                    Retry
                  </Button>
                )
              }
            >
              {state.message}
            </Notice>
          </div>
        )}

        {result &&
          (total === 0 && !hasFilters ? (
            <EmptyState title="No unresolved alerts">
              New alerts appear here when the model flags a transaction submitted from Evaluate, or when
              PaySim demonstration alerts are seeded.
            </EmptyState>
          ) : total === 0 ? (
            <EmptyState
              title="No alerts match these filters"
              action={
                <Button size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <AlertTable rows={rows} onSelect={setSelected} selectedId={selected?.id ?? null} />
              <AlertCards rows={rows} onSelect={setSelected} />
              <Pagination
                page={result.page}
                pageCount={result.pageCount}
                start={(result.page - 1) * PAGE_SIZE}
                shown={rows.length}
                total={total}
                busy={fetching}
                onPage={(next) => setFilters({ page: next })}
              />
            </>
          ))}
      </Panel>

      {result && (
        <p className="mt-3 text-xs text-ink-3">
          {hasFilters ? `${total} ${total === 1 ? "alert matches" : "alerts match"} the current filters. ` : ""}
          {result.unverified
            ? `${result.unverified} alert${result.unverified === 1 ? " on this page was" : "s on this page were"} hidden because the linked transaction does not confirm the alert source. `
            : ""}
          Search matches transaction references, or a full alert or transaction ID. Risk is the model probability
          stored with the alert; PaySim-labelled alerts may have none.
        </p>
      )}

      <AlertDrawer alert={selected} onClose={() => setSelected(null)} onUpdated={handleUpdated} />
    </>
  );
}

function FilterBar({
  filters,
  onChange,
  disabled,
}: {
  filters: QueueFilters;
  onChange: (patch: Partial<QueueFilters>) => void;
  disabled: boolean;
}) {
  // Local draft keeps typing responsive; the URL updates after a short pause.
  const [draft, setDraft] = useState(filters.q);
  const [committed, setCommitted] = useState(filters.q);

  // Back/forward navigation or "Clear filters" changes the URL directly.
  if (filters.q !== committed) {
    setCommitted(filters.q);
    setDraft(filters.q);
  }

  useEffect(() => {
    if (draft === filters.q) return;
    const timer = window.setTimeout(() => onChange({ q: draft }), 250);
    return () => window.clearTimeout(timer);
  }, [draft, filters.q, onChange]);

  // inputClass sets w-full; filters size to their content instead.
  const selectClass = cx(inputClass.replace("w-full", "w-auto"), "h-8 pr-7 text-[0.8125rem]");

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
      <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
        <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <label htmlFor="alert-search" className="sr-only">
          Search alerts
        </label>
        <input
          id="alert-search"
          type="search"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Transaction reference or ID"
          className={cx(inputClass, "h-8 pl-8 text-[0.8125rem]")}
        />
      </div>

      <label className="sr-only" htmlFor="filter-severity">
        Severity
      </label>
      <select
        id="filter-severity"
        className={selectClass}
        disabled={disabled}
        value={filters.severity}
        onChange={(event) => onChange({ severity: event.target.value as QueueFilters["severity"] })}
      >
        <option value="all">All severities</option>
        {SEVERITY_ORDER.map((severity) => (
          <option key={severity} value={severity}>
            {SEVERITY_LABEL[severity]}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="filter-status">
        Review status
      </label>
      <select
        id="filter-status"
        className={selectClass}
        disabled={disabled}
        value={filters.status}
        onChange={(event) => onChange({ status: event.target.value as QueueFilters["status"] })}
      >
        <option value="all">Open and investigating</option>
        <option value="open">Open</option>
        <option value="investigating">Investigating</option>
      </select>

      <label className="sr-only" htmlFor="filter-source">
        Alert source
      </label>
      <select
        id="filter-source"
        className={selectClass}
        disabled={disabled}
        value={filters.source}
        onChange={(event) => onChange({ source: event.target.value as QueueFilters["source"] })}
      >
        <option value="all">All sources</option>
        <option value="model_prediction">Model flags</option>
        <option value="ground_truth_demo">PaySim labels</option>
      </select>

      <div className="ml-auto flex items-center gap-2">
        <label htmlFor="sort" className="text-xs text-ink-3">
          Sort
        </label>
        <select
          id="sort"
          className={selectClass}
          disabled={disabled}
          value={filters.sort}
          onChange={(event) => onChange({ sort: event.target.value as QueueFilters["sort"], page: filters.page })}
        >
          <option value="risk">Highest risk</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
      </div>
    </div>
  );
}

function RiskMeter({ alert }: { alert: AlertRecord }) {
  const score = alertScore(alert);

  if (score === null || score < 0 || score > 1) {
    return <span className="text-ink-3">No score</span>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken">
        <span className="block h-full rounded-full bg-ink-2" style={{ width: `${score * 100}%` }} />
      </span>
      <span className="tabular-nums">{formatProbability(score)}</span>
    </span>
  );
}

function transactionRef(alert: AlertRecord) {
  return alert.transaction?.external_transaction_id ?? alert.transaction_id;
}

function AlertTable({
  rows,
  onSelect,
  selectedId,
}: {
  rows: AlertRecord[];
  onSelect: (alert: AlertRecord) => void;
  selectedId: string | null;
}) {
  const th = "px-3 py-2 text-left text-xs font-medium text-ink-3";
  const td = "px-3 py-2.5 align-middle";

  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[56rem] border-collapse">
        <caption className="sr-only">Unresolved alerts. Select a transaction to review it.</caption>
        <thead className="border-b border-line bg-canvas/60">
          <tr>
            <th scope="col" className={th}>Transaction</th>
            <th scope="col" className={th}>Severity</th>
            <th scope="col" className={th}>Model risk</th>
            <th scope="col" className={th}>Type</th>
            <th scope="col" className={cx(th, "text-right")}>Amount</th>
            <th scope="col" className={th}>Source</th>
            <th scope="col" className={th}>Status</th>
            <th scope="col" className={th}>Raised</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((alert) => {
            const reference = transactionRef(alert);
            return (
              <tr
                key={alert.id}
                onClick={() => onSelect(alert)}
                className={cx(
                  "cursor-pointer border-b border-line last:border-0 hover:bg-canvas",
                  selectedId === alert.id && "bg-accent-soft hover:bg-accent-soft"
                )}
              >
                <td className={cx(td, "max-w-[16rem]")}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(alert);
                    }}
                    title={reference}
                    className="block max-w-full truncate text-left font-mono text-[0.8125rem] text-accent hover:underline"
                  >
                    {reference}
                  </button>
                </td>
                <td className={td}>
                  <SeverityBadge severity={asSeverity(alert.severity)} />
                </td>
                <td className={td}>
                  <RiskMeter alert={alert} />
                </td>
                <td className={cx(td, "text-ink-2")}>{alert.transaction?.transaction_type ?? "—"}</td>
                <td className={cx(td, "text-right tabular-nums")}>{formatAmount(alert.transaction?.amount)}</td>
                <td className={td}>
                  <SourceBadge source={alert.alert_source} />
                </td>
                <td className={td}>
                  <StatusBadge status={asStatus(alert.status)} />
                </td>
                <td className={cx(td, "whitespace-nowrap text-xs text-ink-3")}>{formatTimestamp(alert.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AlertCards({ rows, onSelect }: { rows: AlertRecord[]; onSelect: (alert: AlertRecord) => void }) {
  return (
    <ul className="divide-y divide-line md:hidden">
      {rows.map((alert) => (
        <li key={alert.id}>
          <button type="button" onClick={() => onSelect(alert)} className="w-full px-4 py-3 text-left hover:bg-canvas">
            <div className="flex items-center justify-between gap-3">
              <Mono className="truncate text-accent">{transactionRef(alert)}</Mono>
              <SeverityBadge severity={asSeverity(alert.severity)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.8125rem]">
              <RiskMeter alert={alert} />
              <span className="tabular-nums">{formatAmount(alert.transaction?.amount)}</span>
              <span className="text-ink-2">{alert.transaction?.transaction_type ?? "—"}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <SourceBadge source={alert.alert_source} />
              <StatusBadge status={asStatus(alert.status)} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Pagination({
  page,
  pageCount,
  start,
  shown,
  total,
  busy,
  onPage,
}: {
  page: number;
  pageCount: number;
  start: number;
  shown: number;
  total: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label="Alert pages" className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5">
      <p className="text-xs text-ink-3" aria-live="polite">
        {start + 1}–{start + shown} of {total}
        {total > PAGE_SIZE ? ` · page ${page} of ${pageCount}` : ""}
      </p>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => onPage(page - 1)} disabled={busy || page <= 1} aria-label="Previous page">
          <Icon name="chevron-left" />
        </Button>
        <Button size="sm" onClick={() => onPage(page + 1)} disabled={busy || page >= pageCount} aria-label="Next page">
          <Icon name="chevron-right" />
        </Button>
      </div>
    </nav>
  );
}

function QueueSkeleton() {
  return (
    <div className="divide-y divide-line" role="status" aria-label="Loading alerts">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-6 px-3 py-3.5">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="ml-auto h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}
