"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Transaction = {
  id: string;
  external_transaction_id: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | string | null;
  model_version: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

type AlertStatus = "open" | "investigating" | "resolved";

type Alert = {
  id: string;
  transaction_id: string;
  severity: string | null;
  status: string | null;
  risk_score: number | string | null;
  reason: string | null;
  created_at: string;
  transaction: Transaction | null;
  alert_source: "model_prediction" | "ground_truth_demo";
};

type AlertsResponse = {
  alerts?: Alert[];
  error?: string;
};

type UpdateResponse = {
  message?: string;
  error?: string;
  alert?: {
    id: string;
    status: AlertStatus;
  };
};

export default function AlertQueue() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [updatingAlertId, setUpdatingAlertId] = useState<string | null>(
    null
  );

  // Fetch the latest unresolved alerts from the server.
  const loadAlerts = useCallback(async () => {
    setLoading(true);
    setError("");
    setSuccessMessage("");

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        throw sessionError;
      }

      if (!session) {
        setAlerts([]);
        throw new Error("Please sign in to view the alert queue.");
      }

      const response = await fetch("/api/alerts", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      const result = (await response.json()) as AlertsResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Failed to load alerts.");
      }

      setAlerts(result.alerts ?? []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while loading alerts."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  // Update an alert only after the authenticated API confirms the change.
  async function updateAlertStatus(
    alert: Alert,
    nextStatus: "investigating" | "resolved"
  ) {
    if (updatingAlertId) return;

    setUpdatingAlertId(alert.id);
    setError("");
    setSuccessMessage("");

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        throw sessionError;
      }

      if (!session) {
        throw new Error("Your session has expired. Please sign in again.");
      }

      const response = await fetch(
        `/api/alerts/${encodeURIComponent(alert.id)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: nextStatus }),
          cache: "no-store",
        }
      );

      const result = (await response.json()) as UpdateResponse;

      if (!response.ok || !result.alert) {
        throw new Error(
          result.error ?? "The alert status could not be updated."
        );
      }

      const confirmedStatus = result.alert.status;

      // Resolved alerts disappear from this unresolved-alert queue.
      if (confirmedStatus === "resolved") {
        setAlerts((current) =>
          current.filter((item) => item.id !== alert.id)
        );
      } else {
        setAlerts((current) =>
          current.map((item) =>
            item.id === alert.id
              ? { ...item, status: confirmedStatus }
              : item
          )
        );
      }

      setSuccessMessage(
        `Alert ${alert.id.slice(0, 8)} marked as ${confirmedStatus}.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred."
      );
    } finally {
      setUpdatingAlertId(null);
    }
  }

  function formatAmount(
    amount: number | string | null | undefined
  ): string {
    if (
      amount === null ||
      amount === undefined ||
      amount === ""
    ) {
      return "—";
    }

    const value = Number(amount);

    return Number.isFinite(value)
      ? value.toLocaleString("en-IN", {
          maximumFractionDigits: 2,
        })
      : "—";
  }

  function formatRisk(
    score: number | string | null | undefined
  ): string {
    if (
      score === null ||
      score === undefined ||
      score === ""
    ) {
      return "—";
    }

    const value = Number(score);

    if (!Number.isFinite(value) || value < 0) {
      return "—";
    }

    const percentage = value <= 1 ? value * 100 : value;

    return `${percentage.toFixed(1)}%`;
  }

  function formatDate(
    dateString: string | null | undefined
  ): string {
    if (!dateString) return "—";

    const date = new Date(dateString);

    if (Number.isNaN(date.getTime())) {
      return "—";
    }

    return `${date
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")} UTC`;
  }

  function severityClass(value: string | null): string {
    switch (value?.toLowerCase()) {
      case "critical":
      case "high":
        return "border-red-500/40 bg-red-500/10 text-red-400";

      case "medium":
        return "border-amber-500/40 bg-amber-500/10 text-amber-300";

      case "low":
        return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";

      default:
        return "border-slate-700 bg-slate-800 text-slate-300";
    }
  }

  function statusClass(value: string | null): string {
    switch (value?.toLowerCase()) {
      case "open":
        return "border-amber-500/40 bg-amber-500/10 text-amber-300";

      case "investigating":
        return "border-blue-500/40 bg-blue-500/10 text-blue-300";

      case "resolved":
        return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";

      default:
        return "border-slate-700 bg-slate-800 text-slate-300";
    }
  }

  return (
    <section className="space-y-5">
      {/* Header and refresh control */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">
            Alert Queue
          </h2>

          <p className="mt-1 text-sm text-slate-400">
            Investigate suspicious activity and manage unresolved alerts.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAlerts()}
          disabled={loading || updatingAlertId !== null}
          className="rounded-lg border border-slate-700 px-4 py-2
            text-sm text-slate-200 transition hover:bg-slate-800
            disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Action feedback */}
      {successMessage && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-500/30
            bg-emerald-500/10 p-4 text-sm text-emerald-300"
        >
          {successMessage}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30
            bg-red-500/10 p-4 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Alert table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[1550px] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[230px]" />
            <col className="w-[125px]" />
            <col className="w-[110px]" />
            <col className="w-[135px]" />
            <col className="w-[100px]" />
            <col className="w-[100px]" />
            <col className="w-[120px]" />
            <col className="w-[260px]" />
            <col className="w-[170px]" />
            <col className="w-[150px]" />
          </colgroup>

          <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Transaction</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Risk score</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Detected (UTC)</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-800 bg-slate-950">
            {loading ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-4 py-12 text-center text-slate-400"
                >
                  Loading alerts from Supabase...
                </td>
              </tr>
            ) : alerts.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-4 py-12 text-center text-slate-400"
                >
                  No eligible active alerts found.
                </td>
              </tr>
            ) : (
              alerts.map((alert) => {
                const transaction = alert.transaction;

                const transactionId =
                  transaction?.external_transaction_id ??
                  alert.transaction_id;

                const score =
                  alert.risk_score ??
                  transaction?.model_score ??
                  null;

                const isModelPrediction =
                  alert.alert_source === "model_prediction";

                const isUpdating = updatingAlertId === alert.id;

                return (
                  <tr
                    key={alert.id}
                    className="transition hover:bg-slate-900/70"
                  >
                    <td className="overflow-hidden px-4 py-4">
                      <span
                        title={transactionId}
                        className="block truncate font-mono text-xs text-emerald-300"
                      >
                        {transactionId.length > 22
                          ? `${transactionId.slice(0, 22)}…`
                          : transactionId}
                      </span>
                    </td>

                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex whitespace-nowrap rounded-md
                          border px-2 py-1 text-xs ${
                            isModelPrediction
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          }`}
                      >
                        {isModelPrediction ? "MODEL" : "PAYSIM DEMO"}
                      </span>
                    </td>

                    <td className="break-words px-4 py-4 text-slate-300">
                      {transaction?.transaction_type ?? "—"}
                    </td>

                    <td className="px-4 py-4 text-right tabular-nums text-white">
                      {formatAmount(transaction?.amount)}
                    </td>

                    <td className="px-4 py-4 font-semibold text-red-300">
                      {formatRisk(score)}
                    </td>

                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex whitespace-nowrap rounded-md
                          border px-2 py-1 text-xs ${severityClass(
                            alert.severity
                          )}`}
                      >
                        {alert.severity ?? "Unknown"}
                      </span>
                    </td>

                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex whitespace-nowrap rounded-md
                          border px-2 py-1 text-xs ${statusClass(
                            alert.status
                          )}`}
                      >
                        {alert.status ?? "Unknown"}
                      </span>
                    </td>

                    <td className="whitespace-normal break-words px-4 py-4 text-slate-400">
                      {alert.reason ??
                        (isModelPrediction
                          ? "Flagged by the fraud model."
                          : "PaySim demonstration record.")}
                    </td>

                    <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-400">
                      {formatDate(alert.created_at)}
                    </td>

                    {/* Status transition buttons */}
                    <td className="px-4 py-4">
                      {alert.status === "open" ? (
                        <button
                          type="button"
                          onClick={() =>
                            void updateAlertStatus(
                              alert,
                              "investigating"
                            )
                          }
                          disabled={updatingAlertId !== null}
                          className="whitespace-nowrap rounded-lg border
                            border-blue-500/40 bg-blue-500/10 px-3 py-2
                            text-xs font-medium text-blue-300
                            transition hover:bg-blue-500/20
                            disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isUpdating
                            ? "Updating..."
                            : "Investigate"}
                        </button>
                      ) : alert.status === "investigating" ? (
                        <button
                          type="button"
                          onClick={() =>
                            void updateAlertStatus(alert, "resolved")
                          }
                          disabled={updatingAlertId !== null}
                          className="whitespace-nowrap rounded-lg border
                            border-emerald-500/40 bg-emerald-500/10 px-3 py-2
                            text-xs font-medium text-emerald-300
                            transition hover:bg-emerald-500/20
                            disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isUpdating ? "Updating..." : "Resolve"}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-5 text-slate-500">
        Changes are saved through the authenticated server API.
        Resolved alerts disappear from the active queue. PaySim
        demonstration alerts remain explicitly labelled and are not
        live model predictions. Amounts use dataset units; missing
        risk scores are shown as a dash.
      </p>
    </section>
  );
}