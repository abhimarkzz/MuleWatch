"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { formatAmount, formatProbability } from "@/lib/format";
import { FRAUD_INSERT_EVENT, subscribeToFraudInserts, type FraudToast, type LiveStatus } from "@/lib/realtime-fraud";
import { Button, Icon, Mono, Notice } from "@/components/ui";

const MAX_TOASTS = 3;
const TOAST_MS = 20_000;

/**
 * Slide-in alerts for transactions the model flags, for the signed-in
 * analyst. Rendered inside the session gate, so it only runs while signed in;
 * unmounting (sign-out or leaving the workspace) removes the channel.
 */
export function FraudNotifier({ userId }: { userId: string }) {
  const [toasts, setToasts] = useState<FraudToast[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    let client;
    try {
      client = getSupabase();
    } catch {
      return; // The session gate already shows configuration errors.
    }
    return subscribeToFraudInserts(client, {
      onStatus: setStatus,
      onFraud: (toast) => {
        setToasts((current) => [toast, ...current].slice(0, MAX_TOASTS));
        window.dispatchEvent(new CustomEvent(FRAUD_INSERT_EVENT));
      },
    });
  }, [userId]);

  // Each toast leaves on its own after a while; dismiss removes it sooner.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = window.setTimeout(() => setToasts((current) => current.slice(0, -1)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  const dismiss = (id: string) => setToasts((current) => current.filter((t) => t.id !== id));

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-96">
      {status === "reconnecting" && (
        <div className="pointer-events-auto w-full">
          <Notice tone="warn">Live fraud alerts are paused. Reconnecting…</Notice>
        </div>
      )}
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto w-full rounded-md bg-surface shadow-overlay motion-safe:animate-slide-in">
          <Notice
            tone="danger"
            className="border-l-4"
            title="Model flagged a transaction"
            action={
              <Button size="sm" variant="ghost" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
                <Icon name="close" />
              </Button>
            }
          >
            <p>
              {toast.reference ? <Mono className="break-all">{toast.reference}</Mono> : "A new transaction"} ·{" "}
              <span className="tabular-nums">{formatAmount(toast.amount)}</span>
              {toast.score !== null && <> · score {formatProbability(toast.score, 1)}</>}
            </p>
            <Link href="/alerts?sort=newest" className="mt-1 inline-flex items-center gap-1 font-medium text-accent hover:underline">
              Open alerts <Icon name="arrow-right" />
            </Link>
          </Notice>
        </div>
      ))}
    </div>
  );
}
