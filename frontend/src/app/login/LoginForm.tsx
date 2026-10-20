"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/api-client";
import { Logo } from "@/components/AppShell";
import { safeNextPath } from "@/lib/navigation";
import { Button, cx, Field, inputClass, Notice } from "@/components/ui";

type Mode = "signin" | "signup";

// Self-service sign-up is off unless explicitly enabled: any account that can
// sign in can read investigation data (see MULEWATCH_ANALYST_EMAILS).
const SIGNUP_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SIGNUP === "true";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    try {
      getSupabase()
        .auth.getSession()
        .then(({ data }) => {
          if (!cancelled && data.session) router.replace(next);
        })
        .catch(() => {
          // The form stays usable if the session check fails.
        });
    } catch (caught) {
      queueMicrotask(() => !cancelled && setError(errorMessage(caught, "Supabase is not configured.")));
    }
    return () => {
      cancelled = true;
    };
  }, [router, next]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    setInfo(null);

    try {
      const auth = getSupabase().auth;

      if (mode === "signin") {
        const { data, error: authError } = await auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
        if (!data.session) throw new Error("Sign-in did not return a session. Please try again.");
        router.replace(next);
        return;
      }

      const { data, error: authError } = await auth.signUp({ email: email.trim(), password });
      if (authError) throw authError;
      if (data.session) {
        router.replace(next);
        return;
      }
      setInfo("Account created. Confirm your email address, then sign in.");
      setMode("signin");
    } catch (caught) {
      const message = errorMessage(caught, "Authentication failed.");
      setError(/invalid login credentials/i.test(message) ? "The email or password is incorrect." : message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex items-center gap-2.5">
        <Logo />
        <span className="text-base font-semibold tracking-[-0.01em]">MuleWatch</span>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold">{mode === "signin" ? "Sign in" : "Create an analyst account"}</h1>
        <p className="mt-1 text-ink-2">Transaction risk and fraud-network investigation.</p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field label="Email" htmlFor="email">
            <input
              id="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            label="Password"
            htmlFor="password"
            hint={mode === "signup" ? "At least 8 characters." : undefined}
          >
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={mode === "signup" ? "password-hint" : undefined}
              className={inputClass}
            />
          </Field>

          {error && <Notice tone="danger">{error}</Notice>}
          {info && <Notice tone="ok">{info}</Notice>}

          <Button type="submit" variant="primary" busy={submitting} className="w-full">
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        {SIGNUP_ENABLED && (
          <p className="mt-4 text-center text-[0.8125rem] text-ink-2">
            {mode === "signin" ? "No account yet?" : "Already registered?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setInfo(null);
              }}
              className={cx("font-medium text-accent hover:underline")}
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </p>
        )}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-ink-3">
        A research prototype using the synthetic PaySim dataset. Model output is a risk estimate for review, not a fraud
        determination.
      </p>
    </div>
  );
}
