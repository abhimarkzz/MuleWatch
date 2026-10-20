import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <Suspense fallback={<p className="text-ink-2" role="status">Loading sign-in…</p>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
