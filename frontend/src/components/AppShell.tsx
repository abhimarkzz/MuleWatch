"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase";
import { useSession } from "@/components/session";
import { FraudNotifier } from "@/components/FraudNotifier";
import { Button, cx, Icon } from "@/components/ui";

const NAV = [
  { href: "/alerts", label: "Alerts", icon: "alert" },
  { href: "/network", label: "Network", icon: "network" },
  { href: "/evaluate", label: "Evaluate", icon: "beaker" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await getSupabase().auth.signOut();
    } finally {
      router.replace("/login");
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-4 px-4 sm:gap-6 sm:px-6">
          <Link href="/alerts" className="flex items-center gap-2 font-semibold tracking-[-0.01em]">
            <Logo />
            <span className="hidden sm:inline">MuleWatch</span>
          </Link>

          <nav aria-label="Primary" className="flex h-full items-stretch gap-0.5">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "relative flex items-center gap-1.5 px-2.5 text-[0.8125rem] font-medium sm:px-3",
                    active ? "text-ink" : "text-ink-3 hover:text-ink"
                  )}
                >
                  <Icon name={item.icon} className="hidden sm:block" />
                  {item.label}
                  {active && <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-xs text-ink-3 md:inline" title={session.user.email}>
              {session.user.email}
            </span>
            <Button size="sm" variant="ghost" onClick={signOut} busy={signingOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>

      <FraudNotifier userId={session.user.id} />

      <footer className="border-t border-line">
        <p className="mx-auto max-w-[90rem] px-4 py-3 text-xs text-ink-3 sm:px-6">
          Investigation prototype on synthetic PaySim data. Model scores are risk estimates, not
          fraud determinations, and nothing here blocks payments.
        </p>
      </footer>
    </div>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
      <rect width="24" height="24" rx="5" className="fill-ink" />
      <circle cx="7" cy="8" r="2" className="fill-white" />
      <circle cx="17" cy="8" r="2" className="fill-white" />
      <circle cx="12" cy="17" r="2.4" fill="#e0a43a" />
      <path d="M7 8h10M7 8l5 9m5-9-5 9" stroke="white" strokeWidth="1.3" fill="none" opacity="0.7" />
    </svg>
  );
}
