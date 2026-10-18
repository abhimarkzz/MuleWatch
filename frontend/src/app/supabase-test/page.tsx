"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function SupabaseTestPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("Not tested yet.");

  async function testConnection() {
    setLoading(true);
    setResult("Connecting to Supabase...");

    try {
      const { data, error } = await supabase
        .from("transactions")
        .select("id")
        .limit(1);

      if (error) {
        setResult(
          `Supabase returned an error: ${error.message}. ` +
          "Check the URL, publishable key, and database permissions."
        );
      } else if (!data || data.length === 0) {
        setResult(
          "Supabase responded successfully, but no rows are visible. " +
          "This can be expected while RLS blocks public reads."
        );
      } else {
        setResult(
          "Connected successfully! The query returned a transaction row."
        );
      }
    } catch {
      setResult(
        "Could not reach Supabase. Check your network and configuration."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-white">
      <section className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-8">
        <p className="text-sm font-medium text-emerald-400">
          MULEWATCH / DAY 10
        </p>

        <h1 className="mt-3 text-3xl font-bold">
          Supabase Connection
        </h1>

        <p className="mt-3 text-slate-400">
          Test the connection between the Next.js frontend
          and your Supabase database.
        </p>

        <button
          onClick={testConnection}
          disabled={loading}
          className="mt-6 rounded-lg bg-emerald-500 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
        >
          {loading ? "Testing..." : "Test Supabase Connection"}
        </button>

        <div
          role="status"
          aria-live="polite"
          className="mt-5 break-words rounded-lg border border-slate-700 bg-slate-950 p-4 text-sm"
        >
          {result}
        </div>
      </section>
    </main>
  );
}