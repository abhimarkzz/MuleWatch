"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiRequest, errorMessage } from "@/lib/api-client";
import { formatProbability } from "@/lib/format";
import { Button, cx, Field, Icon, inputClass, Mono, Notice, PageHeader, Panel } from "@/components/ui";

const TRANSACTION_TYPES = ["TRANSFER", "CASH_OUT", "PAYMENT", "CASH_IN", "DEBIT"] as const;

type FormValues = {
  type: (typeof TRANSACTION_TYPES)[number];
  amount: string;
  step: string;
  oldbalanceOrg: string;
  oldbalanceDest: string;
  orig_txn_count_before: string;
  dest_txn_count_before: string;
  dest_is_merchant: "0" | "1";
  source_account_external_id: string;
  destination_account_external_id: string;
};

type FieldErrors = Partial<Record<keyof FormValues, string>>;

type PredictionResult = {
  transaction_id: string;
  external_transaction_id: string;
  predicted_is_fraud: boolean;
  fraud_probability: number;
  model_version: string;
  decision_threshold?: number | null;
  saved_to_supabase: boolean;
  alert_created: boolean;
};

// Example values only; edit them to describe the transaction under review.
const INITIAL_FORM: FormValues = {
  type: "TRANSFER",
  amount: "5000",
  step: "100",
  oldbalanceOrg: "10000",
  oldbalanceDest: "2000",
  orig_txn_count_before: "1",
  dest_txn_count_before: "4",
  dest_is_merchant: "0",
  source_account_external_id: "C100100",
  destination_account_external_id: "C200200",
};

// Server allows 90 s for a Render cold start; the browser waits slightly longer.
const CLIENT_TIMEOUT_MS = 100_000;

function validate(form: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  const money = ["amount", "oldbalanceOrg", "oldbalanceDest"] as const;
  const whole = ["step", "orig_txn_count_before", "dest_txn_count_before"] as const;

  for (const key of money) {
    const value = Number(form[key]);
    if (form[key].trim() === "" || !Number.isFinite(value)) errors[key] = "Enter a number.";
    else if (value < 0) errors[key] = "Cannot be negative.";
    else if (value > 1e12) errors[key] = "Value is outside the supported range.";
  }

  for (const key of whole) {
    const value = Number(form[key]);
    if (form[key].trim() === "" || !Number.isInteger(value)) errors[key] = "Enter a whole number.";
    else if (value < 0) errors[key] = "Cannot be negative.";
    else if (value > 1e7) errors[key] = "Value is outside the supported range.";
  }

  for (const key of ["source_account_external_id", "destination_account_external_id"] as const) {
    if (form[key].trim().length > 200) errors[key] = "Use 200 characters or fewer.";
  }

  return errors;
}

export function EvaluateTransaction() {
  const [form, setForm] = useState<FormValues>(INITIAL_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Reusing the reference on retry lets the server upsert instead of
  // inserting a duplicate if an earlier attempt saved but its response was lost.
  const attemptRef = useRef<{ fingerprint: string; reference: string } | null>(null);

  useEffect(() => {
    if (!submitting) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      window.clearInterval(timer);
      setElapsed(0);
    };
  }, [submitting]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (submitting) return;

    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      const first = Object.keys(nextErrors)[0];
      document.getElementById(`ev-${first}`)?.focus();
      return;
    }

    const fingerprint = JSON.stringify(form);
    if (attemptRef.current?.fingerprint !== fingerprint) {
      attemptRef.current = { fingerprint, reference: `mulewatch-ui-${crypto.randomUUID()}` };
    }

    setSubmitting(true);
    setFailure(null);
    setResult(null);

    try {
      const prediction = await apiRequest<PredictionResult>("/api/predict", {
        method: "POST",
        timeoutMs: CLIENT_TIMEOUT_MS,
        body: {
          type: form.type,
          amount: Number(form.amount),
          step: Number(form.step),
          oldbalanceOrg: Number(form.oldbalanceOrg),
          oldbalanceDest: Number(form.oldbalanceDest),
          orig_txn_count_before: Number(form.orig_txn_count_before),
          dest_txn_count_before: Number(form.dest_txn_count_before),
          dest_is_merchant: Number(form.dest_is_merchant),
          external_transaction_id: attemptRef.current.reference,
          source_account_external_id: form.source_account_external_id.trim() || undefined,
          destination_account_external_id: form.destination_account_external_id.trim() || undefined,
        },
      });

      if (typeof prediction.predicted_is_fraud !== "boolean" || typeof prediction.fraud_probability !== "number") {
        throw new ApiError("The server returned an unexpected prediction response.", 502, false);
      }

      setResult(prediction);
      // A later submission is a new transaction even if the fields match.
      attemptRef.current = null;
    } catch (error) {
      setFailure({
        message:
          error instanceof ApiError && error.code === "TIMEOUT"
            ? "No response after 100 seconds. The model service may still be starting; retrying is safe and will not create a duplicate."
            : errorMessage(error, "The prediction could not be completed."),
        retryable: !(error instanceof ApiError) || error.retryable,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setForm(INITIAL_FORM);
    setErrors({});
    setFailure(null);
    setResult(null);
    attemptRef.current = null;
  }

  const numberInput = (key: keyof FormValues, props: { step?: string } = {}) => (
    <input
      id={`ev-${key}`}
      type="number"
      inputMode="decimal"
      min="0"
      step={props.step ?? "any"}
      required
      disabled={submitting}
      value={form[key]}
      onChange={(event) => update(key, event.target.value as FormValues[typeof key])}
      aria-invalid={errors[key] ? true : undefined}
      aria-describedby={errors[key] ? `ev-${key}-error` : `ev-${key}-hint`}
      className={cx(inputClass, "tabular-nums")}
    />
  );

  return (
    <>
      <PageHeader
        title="Evaluate a transaction"
        description="Score a transaction with the deployed Random Forest model. The result is stored, and the model opens an alert if the score meets its decision threshold."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel>
          <form ref={formRef} onSubmit={submit} noValidate className="divide-y divide-line">
            <fieldset className="grid gap-4 p-5 sm:grid-cols-3" disabled={submitting}>
              <legend className="sr-only">Transaction</legend>
              <p aria-hidden="true" className="text-[0.8125rem] font-semibold sm:col-span-3">Transaction</p>
              <Field label="Type" htmlFor="ev-type">
                <select
                  id="ev-type"
                  value={form.type}
                  onChange={(event) => update("type", event.target.value as FormValues["type"])}
                  className={inputClass}
                >
                  {TRANSACTION_TYPES.map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount" htmlFor="ev-amount" error={errors.amount} hint="Dataset units, no currency.">
                {numberInput("amount")}
              </Field>
              <Field label="PaySim step" htmlFor="ev-step" error={errors.step} hint="Hour index in the simulation.">
                {numberInput("step", { step: "1" })}
              </Field>
            </fieldset>

            <fieldset className="grid gap-4 p-5 sm:grid-cols-2" disabled={submitting}>
              <legend className="sr-only">Balances and history</legend>
              <p aria-hidden="true" className="text-[0.8125rem] font-semibold sm:col-span-2">Balances and history</p>
              <Field label="Sender balance before" htmlFor="ev-oldbalanceOrg" error={errors.oldbalanceOrg}>
                {numberInput("oldbalanceOrg")}
              </Field>
              <Field label="Receiver balance before" htmlFor="ev-oldbalanceDest" error={errors.oldbalanceDest}>
                {numberInput("oldbalanceDest")}
              </Field>
              <Field
                label="Sender's earlier transactions"
                htmlFor="ev-orig_txn_count_before"
                error={errors.orig_txn_count_before}
                hint="Count before this transaction."
              >
                {numberInput("orig_txn_count_before", { step: "1" })}
              </Field>
              <Field
                label="Receiver's earlier transactions"
                htmlFor="ev-dest_txn_count_before"
                error={errors.dest_txn_count_before}
                hint="Count before this transaction."
              >
                {numberInput("dest_txn_count_before", { step: "1" })}
              </Field>
              <Field label="Receiver is a merchant" htmlFor="ev-dest_is_merchant">
                <select
                  id="ev-dest_is_merchant"
                  value={form.dest_is_merchant}
                  onChange={(event) => update("dest_is_merchant", event.target.value as "0" | "1")}
                  className={inputClass}
                >
                  <option value="0">No</option>
                  <option value="1">Yes</option>
                </select>
              </Field>
            </fieldset>

            <fieldset className="grid gap-4 p-5 sm:grid-cols-2" disabled={submitting}>
              <legend className="sr-only">Accounts</legend>
              <div className="sm:col-span-2">
                <p aria-hidden="true" className="text-[0.8125rem] font-semibold">Accounts</p>
                <p className="text-xs text-ink-3">Optional. Not used by the model; linking them adds the transaction to the network.</p>
              </div>
              <Field label="Sender account ID" htmlFor="ev-source_account_external_id" error={errors.source_account_external_id}>
                <input
                  id="ev-source_account_external_id"
                  maxLength={200}
                  spellCheck={false}
                  autoCapitalize="none"
                  value={form.source_account_external_id}
                  onChange={(event) => update("source_account_external_id", event.target.value)}
                  className={cx(inputClass, "font-mono")}
                />
              </Field>
              <Field label="Receiver account ID" htmlFor="ev-destination_account_external_id" error={errors.destination_account_external_id}>
                <input
                  id="ev-destination_account_external_id"
                  maxLength={200}
                  spellCheck={false}
                  autoCapitalize="none"
                  value={form.destination_account_external_id}
                  onChange={(event) => update("destination_account_external_id", event.target.value)}
                  className={cx(inputClass, "font-mono")}
                />
              </Field>
            </fieldset>

            <div className="flex flex-wrap items-center gap-2 bg-canvas/60 px-5 py-3.5">
              <Button type="submit" variant="primary" busy={submitting}>
                {submitting ? "Scoring…" : "Score transaction"}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={submitting}>
                Reset to example
              </Button>
            </div>
          </form>
        </Panel>

        <div className="space-y-4" aria-live="polite">
          {submitting && (
            <Panel className="p-4">
              <p className="font-medium">Waiting for the model service · {elapsed}s</p>
              <p className="mt-1 text-ink-2">
                {elapsed >= 8
                  ? "The hosted model sleeps when idle and can take up to a minute to start. Keep this page open."
                  : "Sending features to the inference API."}
              </p>
            </Panel>
          )}

          {failure && !submitting && (
            <Notice
              tone="danger"
              title="Scoring did not complete"
              action={
                failure.retryable && (
                  <Button size="sm" onClick={() => formRef.current?.requestSubmit()}>
                    Retry
                  </Button>
                )
              }
            >
              {failure.message} Your inputs are unchanged.
            </Notice>
          )}

          {result && !submitting && <PredictionCard result={result} />}

          {!result && !failure && !submitting && (
            <Panel className="p-4 text-ink-2">
              <p className="font-medium text-ink">How scores are produced</p>
              <p className="mt-1">
                The eight features on the left are sent to a FastAPI service running a scikit-learn Random Forest
                trained on a 100,000-row PaySim sample. It returns a fraud probability; the service compares it with
                a threshold tuned for F1 on out-of-fold training predictions.
              </p>
              <p className="mt-2 text-xs text-ink-3">PaySim is synthetic. Scores describe model behaviour, not real customers.</p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function PredictionCard({ result }: { result: PredictionResult }) {
  const threshold = result.decision_threshold;
  const flagged = result.predicted_is_fraud;

  return (
    <Panel className="overflow-hidden">
      <div className={cx("border-b px-4 py-3", flagged ? "border-risk-high/30 bg-risk-high-soft" : "border-line bg-canvas")}>
        <p className={cx("flex items-center gap-1.5 font-semibold", flagged ? "text-risk-high" : "text-ink")}>
          <Icon name={flagged ? "warning" : "check"} />
          {flagged ? "Flagged for review" : "Below review threshold"}
        </p>
        <p className="mt-0.5 text-xs text-ink-2">A model estimate. It does not confirm or rule out fraud.</p>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <p className="text-xs text-ink-3">Fraud probability</p>
          <p className="text-3xl font-semibold tabular-nums tracking-tight">{formatProbability(result.fraud_probability, 2)}</p>
          {typeof threshold === "number" && (
            <div className="mt-2">
              <div className="relative h-2 rounded-full bg-sunken" aria-hidden="true">
                <div
                  className={cx("h-full rounded-full", flagged ? "bg-risk-high" : "bg-ink-3")}
                  style={{ width: `${Math.min(100, result.fraud_probability * 100)}%` }}
                />
                <div className="absolute -top-1 h-4 w-px bg-ink" style={{ left: `${threshold * 100}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-ink-3">Decision threshold {formatProbability(threshold, 1)}</p>
            </div>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-[0.8125rem]">
          <div>
            <dt className="text-xs text-ink-3">Stored</dt>
            <dd>{result.saved_to_supabase ? "Saved to database" : "Not confirmed"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Alert</dt>
            <dd>{result.alert_created ? "New alert opened" : flagged ? "Already had an alert" : "Not needed"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-ink-3">Reference</dt>
            <dd>
              <Mono className="break-all">{result.external_transaction_id}</Mono>
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-ink-3">Model</dt>
            <dd>{result.model_version}</dd>
          </div>
        </dl>

        {result.alert_created && (
          <Link href="/alerts?sort=newest" className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-accent hover:underline">
            Open the alert queue <Icon name="arrow-right" />
          </Link>
        )}
      </div>
    </Panel>
  );
}
