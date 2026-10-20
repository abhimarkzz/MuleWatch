"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type TransactionType =
  | "PAYMENT"
  | "TRANSFER"
  | "CASH_OUT"
  | "CASH_IN"
  | "DEBIT";

type FormValues = {
  step: string;
  type: TransactionType;
  amount: string;
  oldbalanceOrg: string;
  oldbalanceDest: string;
  orig_txn_count_before: string;
  dest_txn_count_before: string;
  dest_is_merchant: string;
  source_account_external_id: string;
  destination_account_external_id: string;
};

type PredictionResult = {
  transaction_id?: string;
  external_transaction_id?: string;
  predicted_is_fraud?: boolean;
  fraud_probability?: number;
  model_version?: string;
  saved_to_supabase?: boolean;
  alert_created?: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
};

const INITIAL_FORM: FormValues = {
  step: "100",
  type: "TRANSFER",
  amount: "5000",
  oldbalanceOrg: "10000",
  oldbalanceDest: "2000",
  orig_txn_count_before: "1",
  dest_txn_count_before: "4",
  dest_is_merchant: "0",
  source_account_external_id: "C100100",
  destination_account_external_id: "C200200",
};

const inputClassName =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

const labelClassName =
  "block text-sm font-medium text-slate-700";

export default function PredictionPanel() {
  const [form, setForm] = useState<FormValues>(INITIAL_FORM);
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [message, setMessage] = useState(
    "Enter transaction details to run a fraud prediction."
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PredictionResult | null>(null);

  // Keep the same ID when retrying identical input. If the server saved
  // the transaction but the response was lost, this helps avoid a duplicate.
  const requestIdRef = useRef<{
    fingerprint: string;
    id: string;
  } | null>(null);

  const loadingStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!loading) return;

    const timer = window.setInterval(() => {
      const startedAt = loadingStartedAtRef.current;

      if (startedAt !== null) {
        setElapsedSeconds(
          Math.floor((Date.now() - startedAt) / 1000)
        );
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading]);

  function updateField<K extends keyof FormValues>(
    field: K,
    value: FormValues[K]
  ) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function submitTransaction(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setError(null);
    setResult(null);
    setElapsedSeconds(0);
    setMessage("Connecting to the fraud prediction service...");

    loadingStartedAtRef.current = Date.now();
    setLoading(true);

    try {
      // Get the signed-in user's current Supabase access token.
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        throw new Error(
          "Could not verify your session. Please sign in again."
        );
      }

      if (!session?.access_token) {
        setError(
          "Your session has expired or you are not signed in. Please sign in and try again."
        );
        setMessage("Authentication required.");
        return;
      }

      // Keep the same transaction ID for a retry with identical form data.
      const fingerprint = JSON.stringify(form);

      if (
        !requestIdRef.current ||
        requestIdRef.current.fingerprint !== fingerprint
      ) {
        requestIdRef.current = {
          fingerprint,
          id: `mulewatch-ui-${crypto.randomUUID()}`,
        };
      }

      const payload = {
        step: Number(form.step),
        type: form.type,
        amount: Number(form.amount),
        oldbalanceOrg: Number(form.oldbalanceOrg),
        oldbalanceDest: Number(form.oldbalanceDest),
        orig_txn_count_before: Number(form.orig_txn_count_before),
        dest_txn_count_before: Number(form.dest_txn_count_before),
        dest_is_merchant: Number(form.dest_is_merchant),

        external_transaction_id: requestIdRef.current.id,

        source_account_external_id:
          form.source_account_external_id.trim() || undefined,

        destination_account_external_id:
          form.destination_account_external_id.trim() || undefined,
      };

      const numericValues = [
        payload.step,
        payload.amount,
        payload.oldbalanceOrg,
        payload.oldbalanceDest,
        payload.orig_txn_count_before,
        payload.dest_txn_count_before,
        payload.dest_is_merchant,
      ];

      if (
        numericValues.some(
          (value) => !Number.isFinite(value) || value < 0
        )
      ) {
        throw new Error(
          "Enter valid, non-negative numbers in all numeric fields."
        );
      }

      if (
        !Number.isInteger(payload.step) ||
        !Number.isInteger(payload.orig_txn_count_before) ||
        !Number.isInteger(payload.dest_txn_count_before) ||
        ![0, 1].includes(payload.dest_is_merchant)
      ) {
        throw new Error(
          "Step and transaction counts must be whole numbers. Merchant must be either 0 or 1."
        );
      }

      setMessage("Sending transaction to the prediction service...");

      const response = await fetch("/api/predict", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(100_000),
      });

      const responseBody = (await response
        .json()
        .catch(() => null)) as PredictionResult | null;

      if (!response.ok) {
        setError(
          responseBody?.error ??
            `The prediction request failed with status ${response.status}.`
        );

        setMessage(
          responseBody?.retryable
            ? "The service may recover. You can retry the request."
            : "The request could not be completed."
        );

        return;
      }

      if (
        !responseBody ||
        typeof responseBody.predicted_is_fraud !== "boolean" ||
        typeof responseBody.fraud_probability !== "number"
      ) {
        throw new Error(
          "The server returned an unexpected prediction response."
        );
      }

      setResult(responseBody);
      setMessage("Prediction completed.");

      // The successful submission is complete. A subsequent submission
      // should be treated as a new transaction, even with the same fields.
      requestIdRef.current = null;
    } catch (caughtError) {
      const errorName =
        caughtError instanceof Error ? caughtError.name : "";

      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : "An unexpected error occurred.";

      if (
        errorName === "TimeoutError" ||
        errorName === "AbortError"
      ) {
        setError(
          "The request took too long. Render may still be waking up, or the service may be unavailable. Please retry shortly."
        );
      } else {
        setError(errorMessage);
      }

      setMessage("The prediction request did not complete.");
    } finally {
      setLoading(false);
      loadingStartedAtRef.current = null;
    }
  }

  function startNewTransaction() {
    setForm(INITIAL_FORM);
    setResult(null);
    setError(null);
    setElapsedSeconds(0);
    setMessage(
      "Enter transaction details to run a new fraud prediction."
    );
    requestIdRef.current = null;
  }

  const waitingMessage =
    elapsedSeconds >= 30
      ? "The first prediction can take around a minute while Render wakes up. Please keep this page open."
      : elapsedSeconds >= 8
        ? "Render may be waking up after being idle. The request is still in progress."
        : "Contacting the model API. Please wait.";

  return (
    <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">
            MuleWatch · Model inference
          </p>

          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
            Transaction fraud prediction
          </h2>

          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
            Submit a transaction to the deployed Random Forest API.
            The result is saved to Supabase, and a fraud alert is
            created when the model flags the transaction.
          </p>
        </div>

        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
          <span
            className={`h-2 w-2 rounded-full ${
              loading ? "animate-pulse bg-amber-500" : "bg-emerald-500"
            }`}
          />
          {loading ? "Processing" : "Ready"}
        </span>
      </div>

      <form onSubmit={submitTransaction} className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className={labelClassName} htmlFor="mw-step">
              Transaction step
            </label>
            <input
              id="mw-step"
              className={inputClassName}
              type="number"
              min="0"
              step="1"
              required
              disabled={loading}
              value={form.step}
              onChange={(event) =>
                updateField("step", event.target.value)
              }
            />
          </div>

          <div>
            <label className={labelClassName} htmlFor="mw-type">
              Transaction type
            </label>
            <select
              id="mw-type"
              className={inputClassName}
              required
              disabled={loading}
              value={form.type}
              onChange={(event) =>
                updateField(
                  "type",
                  event.target.value as TransactionType
                )
              }
            >
              <option value="PAYMENT">PAYMENT</option>
              <option value="TRANSFER">TRANSFER</option>
              <option value="CASH_OUT">CASH_OUT</option>
              <option value="CASH_IN">CASH_IN</option>
              <option value="DEBIT">DEBIT</option>
            </select>
          </div>

          <div>
            <label className={labelClassName} htmlFor="mw-amount">
              Transaction amount
            </label>
            <input
              id="mw-amount"
              className={inputClassName}
              type="number"
              min="0"
              step="any"
              required
              disabled={loading}
              value={form.amount}
              onChange={(event) =>
                updateField("amount", event.target.value)
              }
            />
          </div>

          <div>
            <label className={labelClassName} htmlFor="mw-oldbalanceorg">
              Sender balance before
            </label>
            <input
              id="mw-oldbalanceorg"
              className={inputClassName}
              type="number"
              min="0"
              step="any"
              required
              disabled={loading}
              value={form.oldbalanceOrg}
              onChange={(event) =>
                updateField("oldbalanceOrg", event.target.value)
              }
            />
          </div>

          <div>
            <label className={labelClassName} htmlFor="mw-oldbalancedest">
              Receiver balance before
            </label>
            <input
              id="mw-oldbalancedest"
              className={inputClassName}
              type="number"
              min="0"
              step="any"
              required
              disabled={loading}
              value={form.oldbalanceDest}
              onChange={(event) =>
                updateField("oldbalanceDest", event.target.value)
              }
            />
          </div>

          <div>
            <label
              className={labelClassName}
              htmlFor="mw-sender-count"
            >
              Sender's previous transaction count
            </label>
            <input
              id="mw-sender-count"
              className={inputClassName}
              type="number"
              min="0"
              step="1"
              required
              disabled={loading}
              value={form.orig_txn_count_before}
              onChange={(event) =>
                updateField(
                  "orig_txn_count_before",
                  event.target.value
                )
              }
            />
          </div>

          <div>
            <label
              className={labelClassName}
              htmlFor="mw-receiver-count"
            >
              Receiver's previous transaction count
            </label>
            <input
              id="mw-receiver-count"
              className={inputClassName}
              type="number"
              min="0"
              step="1"
              required
              disabled={loading}
              value={form.dest_txn_count_before}
              onChange={(event) =>
                updateField(
                  "dest_txn_count_before",
                  event.target.value
                )
              }
            />
          </div>

          <div>
            <label
              className={labelClassName}
              htmlFor="mw-merchant"
            >
              Is destination a merchant?
            </label>
            <select
              id="mw-merchant"
              className={inputClassName}
              required
              disabled={loading}
              value={form.dest_is_merchant}
              onChange={(event) =>
                updateField("dest_is_merchant", event.target.value)
              }
            >
              <option value="0">No (0)</option>
              <option value="1">Yes (1)</option>
            </select>
          </div>

          <div>
            <label
              className={labelClassName}
              htmlFor="mw-source-account"
            >
              Sender account ID
            </label>
            <input
              id="mw-source-account"
              className={inputClassName}
              type="text"
              maxLength={200}
              disabled={loading}
              value={form.source_account_external_id}
              onChange={(event) =>
                updateField(
                  "source_account_external_id",
                  event.target.value
                )
              }
              placeholder="C100100"
            />
          </div>

          <div>
            <label
              className={labelClassName}
              htmlFor="mw-destination-account"
            >
              Receiver account ID
            </label>
            <input
              id="mw-destination-account"
              className={inputClassName}
              type="text"
              maxLength={200}
              disabled={loading}
              value={form.destination_account_external_id}
              onChange={(event) =>
                updateField(
                  "destination_account_external_id",
                  event.target.value
                )
              }
              placeholder="C200200"
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading && (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
            )}
            {loading ? "Analyzing transaction..." : "Predict fraud"}
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={startNewTransaction}
            className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reset form
          </button>
        </div>
      </form>

      {/* Loading and Render cold-start feedback */}
      {loading && (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 p-4"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-amber-300 border-t-amber-800"
            />

            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-950">
                {waitingMessage}
              </p>

              <p className="mt-1 text-sm text-amber-800">
                {message}
              </p>

              <p className="mt-2 text-xs font-medium tabular-nums text-amber-800">
                Elapsed time: {elapsedSeconds}s
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error state and manual retry */}
      {error && !loading && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50 p-4"
          role="alert"
          aria-live="assertive"
        >
          <p className="text-sm font-semibold text-rose-900">
            Prediction could not be completed
          </p>

          <p className="mt-1 text-sm leading-6 text-rose-800">
            {error}
          </p>

          <p className="mt-2 text-xs text-rose-700">
            Your form values have been kept. You can retry without
            re-entering the transaction.
          </p>

          <button
            type="button"
            onClick={() => {
              const formElement = document.querySelector<HTMLFormElement>(
                "#mulewatch-prediction-form"
              );

              formElement?.requestSubmit();
            }}
            className="mt-3 rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-800 transition hover:bg-rose-100"
          >
            Retry prediction
          </button>
        </div>
      )}

      {/* Result state */}
      {result && !loading && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">
                Prediction result
              </p>

              <p className="mt-1 text-sm text-slate-500">
                {result.predicted_is_fraud
                  ? "The model flagged this transaction for review."
                  : "The model did not flag this transaction as fraudulent."}
              </p>
            </div>

            <span
              className={`inline-flex w-fit rounded-full px-3 py-1.5 text-xs font-semibold ${
                result.predicted_is_fraud
                  ? "bg-rose-100 text-rose-800"
                  : "bg-emerald-100 text-emerald-800"
              }`}
            >
              {result.predicted_is_fraud
                ? "Review recommended"
                : "Not flagged"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Fraud probability
              </p>

              <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">
                {(
                  (result.fraud_probability ?? 0) * 100
                ).toFixed(2)}
                %
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Database status
              </p>

              <p className="mt-2 text-base font-semibold text-slate-900">
                {result.saved_to_supabase
                  ? "Saved to Supabase"
                  : "Not confirmed"}
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Fraud alert
              </p>

              <p className="mt-2 text-base font-semibold text-slate-900">
                {result.alert_created
                  ? "Alert created"
                  : result.predicted_is_fraud
                    ? "No new alert"
                    : "Not required"}
              </p>
            </div>
          </div>

          <div className="space-y-1 text-xs text-slate-500">
            <p>
              <span className="font-medium text-slate-700">
                Model version:
              </span>{" "}
              {result.model_version ?? "Unknown"}
            </p>

            {result.external_transaction_id && (
              <p className="break-all">
                <span className="font-medium text-slate-700">
                  Transaction reference:
                </span>{" "}
                {result.external_transaction_id}
              </p>
            )}

            {result.transaction_id && (
              <p className="break-all">
                <span className="font-medium text-slate-700">
                  Supabase transaction ID:
                </span>{" "}
                {result.transaction_id}
              </p>
            )}
          </div>

          <p className="text-xs leading-5 text-slate-500">
            This is a model prediction, not proof of fraud. Review
            flagged transactions before taking action.
          </p>
        </div>
      )}

      {!loading && !error && !result && (
        <p className="text-sm text-slate-500" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}