"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { getSupabase, SupabaseConfigError } from "@/lib/supabase";
import { Notice, Spinner } from "@/components/ui";
import { safeNextPath } from "@/lib/navigation";

type SessionState =
  | { kind: "checking" }
  | { kind: "config-error"; message: string }
  | { kind: "signed-in"; session: Session };

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionGate>.");
  return session;
}

/**
 * Client-side guard for workspace pages. It decides what to render; it is
 * not the security boundary. Every data route re-verifies the bearer token
 * on the server.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    const toLogin = () =>
      router.replace(`/login?next=${encodeURIComponent(safeNextPath(window.location.pathname + window.location.search))}`);

    let supabase;
    try {
      supabase = getSupabase();
    } catch (error) {
      // Deferred so the state update happens outside the effect body.
      queueMicrotask(() => {
        if (!cancelled) {
          setState({
            kind: "config-error",
            message: error instanceof SupabaseConfigError ? error.message : "Supabase could not be initialised.",
          });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    supabase.auth.getSession().then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data.session) toLogin();
      else setState({ kind: "signed-in", session: data.session });
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      if (!session) toLogin();
      else setState({ kind: "signed-in", session });
    });

    // Raised by apiRequest when the server rejects the token.
    const onUnauthorized = () => {
      void supabase.auth.signOut().finally(toLogin);
    };
    window.addEventListener("mulewatch:unauthorized", onUnauthorized);

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
      window.removeEventListener("mulewatch:unauthorized", onUnauthorized);
    };
  }, [router]);

  if (state.kind === "config-error") {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Notice tone="danger" title="MuleWatch is not configured">
          {state.message}
        </Notice>
      </div>
    );
  }

  if (state.kind === "checking") {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 text-ink-2" role="status">
        <Spinner /> Checking your session…
      </div>
    );
  }

  return <SessionContext.Provider value={state.session}>{children}</SessionContext.Provider>;
}
