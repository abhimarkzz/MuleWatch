"use client";

import PredictionPanel from "@/components/PredictionPanel";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AlertQueue from "@/components/AlertQueue";
import { supabase } from "@/lib/supabase";
import TransactionNetwork from "@/components/TransactionNetwork";

export default function DashboardPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (cancelled) return;

      if (error || !session) {
        router.replace("/login");
        return;
      }

      setReady(true);
    }

    void checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.replace("/login");
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [router]);

  if (!ready) {
    return (
      <main className="min-h-screen bg-slate-950 p-8 text-slate-300">
        Checking your session...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 md:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold tracking-[0.3em] text-emerald-400">
              MULEWATCH
            </p>

            <h1 className="mt-2 text-3xl font-bold text-white">
              Fraud Monitoring
            </h1>

            <p className="mt-2 text-slate-400">
              Monitor and investigate transactions flagged by the model.
            </p>
          </div>

          <button
            type="button"
            onClick={async () => {
              await supabase.auth.signOut();
              router.replace("/login");
            }}
            className="rounded-lg border border-slate-700 px-4 py-2
              text-sm text-slate-200 hover:bg-slate-800"
          >
            Sign out
          </button>
        </header>
        <div className="space-y-8">
            <PredictionPanel />
            <TransactionNetwork />
            <AlertQueue />
        </div>
      </div>
    </main>
  );
}