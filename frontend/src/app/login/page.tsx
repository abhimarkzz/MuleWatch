
"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type AuthMode = "login" | "signup";

export default function LoginPage() {
  const router = useRouter();

  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Redirect users who already have an active Supabase session.
  useEffect(() => {
    let mounted = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        router.replace("/dashboard");
      }
    });

    async function checkExistingSession() {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (!mounted || sessionError) return;

      if (session) {
        router.replace("/dashboard");
      }
    }

    void checkExistingSession();

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [router]);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (loading) return;

    setLoading(true);
    setMessage("");
    setError("");

    try {
      if (mode === "login") {
        const { data, error: authError } =
          await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
          });

        if (authError) {
          throw authError;
        }

        if (!data.session) {
          throw new Error(
            "Sign-in did not return an active session. Please try again."
          );
        }

        setMessage("Successfully signed in to MuleWatch.");

        // Replace the login page with the dashboard.
        router.replace("/dashboard");
        router.refresh();
      } else {
        const { data, error: authError } =
          await supabase.auth.signUp({
            email: email.trim(),
            password,
          });

        if (authError) {
          throw authError;
        }

        if (data.session) {
          setMessage(
            "Account created successfully. Redirecting to the dashboard..."
          );

          router.replace("/dashboard");
          router.refresh();
        } else {
          setMessage(
            "Account created. Check your email for the confirmation link. After confirming, return here to sign in."
          );
        }
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Authentication failed. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setMessage("");
    setError("");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#080b12] px-5 py-12 text-white">
      <section className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10 text-2xl font-bold text-emerald-400">
            M
          </div>

          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-400">
            MuleWatch
          </p>

          <h1 className="mt-4 text-3xl font-bold tracking-tight">
            {mode === "login"
              ? "Welcome back"
              : "Create your account"}
          </h1>

          <p className="mt-3 text-sm text-slate-400">
            {mode === "login"
              ? "Sign in to access your fraud monitoring workspace."
              : "Create an account to get started with MuleWatch."}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-7 shadow-2xl shadow-black/30">
          <div className="mb-6 grid grid-cols-2 rounded-lg bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => changeMode("login")}
              aria-pressed={mode === "login"}
              className={`rounded-md px-3 py-2.5 text-sm font-medium transition ${
                mode === "login"
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Sign in
            </button>

            <button
              type="button"
              onClick={() => changeMode("signup")}
              aria-pressed={mode === "signup"}
              className={`rounded-md px-3 py-2.5 text-sm font-medium transition ${
                mode === "signup"
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Create account
            </button>
          </div>

          <form
            onSubmit={handleSubmit}
            className="space-y-5"
          >
            <div>
              <label
                htmlFor="email"
                className="mb-2 block text-sm font-medium text-slate-200"
              >
                Email address
              </label>

              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) =>
                  setEmail(event.target.value)
                }
                placeholder="you@example.com"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm outline-none placeholder:text-slate-600 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/20"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-sm font-medium text-slate-200"
              >
                Password
              </label>

              <input
                id="password"
                name="password"
                type="password"
                autoComplete={
                  mode === "login"
                    ? "current-password"
                    : "new-password"
                }
                required
                minLength={6}
                value={password}
                onChange={(event) =>
                  setPassword(event.target.value)
                }
                placeholder="Enter your password"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm outline-none placeholder:text-slate-600 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/20"
              />

              <p className="mt-2 text-xs text-slate-500">
                Use at least 6 characters.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-emerald-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading
                ? "Please wait..."
                : mode === "login"
                  ? "Sign in to MuleWatch"
                  : "Create account"}
            </button>
          </form>

          {message && (
            <p
              role="status"
              aria-live="polite"
              className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300"
            >
              {message}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
            >
              {error}
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-xs leading-5 text-slate-500">
          Secure authentication powered by Supabase.
          <br />
          MuleWatch Payment Fraud Detection
        </p>
      </section>
    </main>
  );
}
