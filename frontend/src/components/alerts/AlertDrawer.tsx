"use client";

import Link from "next/link";
import { useState } from "react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { formatAmount, formatProbability, formatTimestamp } from "@/lib/format";
import { asSeverity, asStatus, isPaySimFraudLabel, SOURCE_DESCRIPTION, type AlertStatus } from "@/lib/risk";
import {
  Button,
  DataList,
  Drawer,
  Icon,
  Mono,
  Notice,
  SeverityBadge,
  SourceBadge,
  StatusBadge,
} from "@/components/ui";
import { alertScore } from "@/lib/alert-filters";
import type { AlertRecord, AlertUpdateResponse } from "./types";

export function AlertDrawer({
  alert,
  onClose,
  onUpdated,
}: {
  alert: AlertRecord | null;
  onClose: () => void;
  onUpdated: (id: string, status: string) => void;
}) {
  return (
    <Drawer open={alert !== null} onClose={onClose} title={alert ? "Alert review" : ""}>
      {/* Keyed so per-alert UI state (confirmation, errors) resets on switch. */}
      {alert && <AlertDetails key={alert.id} alert={alert} onUpdated={onUpdated} />}
    </Drawer>
  );
}

function AlertDetails({
  alert,
  onUpdated,
}: {
  alert: AlertRecord;
  onUpdated: (id: string, status: string) => void;
}) {
  const [pending, setPending] = useState<AlertStatus | null>(null);
  const [confirmResolve, setConfirmResolve] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = asStatus(alert.status);
  const transaction = alert.transaction;
  const score = alertScore(alert);
  const accountId = transaction?.source_account_id ?? transaction?.destination_account_id ?? null;

  async function changeStatus(next: AlertStatus) {
    if (pending) return;
    setPending(next);
    setError(null);

    try {
      const result = await apiRequest<AlertUpdateResponse>(`/api/alerts/${encodeURIComponent(alert.id)}`, {
        method: "PATCH",
        body: { status: next },
      });
      onUpdated(alert.id, result.alert.status);
      setConfirmResolve(false);
    } catch (caught) {
      setError(errorMessage(caught, "The status could not be updated."));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="alert-summary">
        <h3 id="alert-summary" className="sr-only">
          Summary
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={asSeverity(alert.severity)} />
          <SourceBadge source={alert.alert_source} />
          <StatusBadge status={status} />
        </div>
        <p className="mt-3 text-ink-2">{alert.reason ?? "No reason was recorded with this alert."}</p>
        <p className="mt-2 text-xs text-ink-3">{SOURCE_DESCRIPTION[alert.alert_source]}</p>
      </section>

      <section aria-labelledby="alert-risk">
        <h3 id="alert-risk" className="mb-2 text-[0.8125rem] font-semibold">
          Model assessment
        </h3>
        <DataList
          items={[
            { label: "Fraud probability", value: score === null ? "Not scored" : formatProbability(score, 2) },
            {
              label: "Model decision",
              value:
                transaction?.predicted_is_fraud === true
                  ? "Flagged for review"
                  : transaction?.predicted_is_fraud === false
                    ? "Not flagged"
                    : "No prediction stored",
            },
            { label: "Model version", value: transaction?.model_version ?? "—" },
            {
              label: "PaySim label",
              value: isPaySimFraudLabel(transaction?.metadata) ? (
                <span className="text-truth">isFraud = 1 (synthetic ground truth)</span>
              ) : (
                "Not labelled fraud"
              ),
            },
          ]}
        />
      </section>

      <section aria-labelledby="alert-transaction">
        <h3 id="alert-transaction" className="mb-2 text-[0.8125rem] font-semibold">
          Transaction
        </h3>
        {transaction ? (
          <DataList
            items={[
              { label: "Reference", value: <Mono className="break-all">{transaction.external_transaction_id ?? "—"}</Mono> },
              { label: "Record ID", value: <Mono className="break-all">{transaction.id}</Mono> },
              { label: "Type", value: transaction.transaction_type ?? "—" },
              { label: "Amount", value: <span className="tabular-nums">{formatAmount(transaction.amount)}</span> },
              { label: "PaySim step", value: transaction.transaction_step ?? "—" },
              { label: "Recorded", value: formatTimestamp(transaction.created_at) },
              {
                label: "Sender account",
                value: transaction.source_account_id ? <Mono className="break-all">{transaction.source_account_id}</Mono> : "Not recorded",
              },
              {
                label: "Receiver account",
                value: transaction.destination_account_id ? (
                  <Mono className="break-all">{transaction.destination_account_id}</Mono>
                ) : (
                  "Not recorded"
                ),
              },
            ]}
          />
        ) : (
          <Notice tone="warn">The linked transaction record could not be found.</Notice>
        )}
        {accountId && (
          <Link
            href={`/network?account=${encodeURIComponent(accountId)}`}
            className="mt-3 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-accent hover:underline"
          >
            Trace sender in network <Icon name="arrow-right" />
          </Link>
        )}
      </section>

      <section aria-labelledby="alert-review" className="rounded-md border border-line bg-canvas p-3.5">
        <h3 id="alert-review" className="text-[0.8125rem] font-semibold">
          Review
        </h3>
        <p className="mt-0.5 text-xs text-ink-3">Raised {formatTimestamp(alert.created_at)}. Status changes are saved immediately.</p>

        {error && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}

        {confirmResolve ? (
          <div className="mt-3">
            <p className="text-ink-2">Resolve this alert? It will leave the active queue.</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" busy={pending === "resolved"} onClick={() => void changeStatus("resolved")}>
                Resolve alert
              </Button>
              <Button size="sm" disabled={pending !== null} onClick={() => setConfirmResolve(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {status === "open" && (
              <Button variant="primary" size="sm" busy={pending === "investigating"} onClick={() => void changeStatus("investigating")}>
                Start investigation
              </Button>
            )}
            {status === "investigating" && (
              <>
                <Button variant="primary" size="sm" disabled={pending !== null} onClick={() => setConfirmResolve(true)}>
                  Resolve…
                </Button>
                <Button size="sm" busy={pending === "open"} onClick={() => void changeStatus("open")}>
                  Return to open
                </Button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
