import { AppShell } from "@/components/AppShell";
import { SessionGate } from "@/components/session";

// Workspace pages render only after the browser confirms a Supabase session
// and then load data client-side, so navigation into them is not instant.
// Each page also opts out, since validation runs per segment.
export const instant = false;

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionGate>
      <AppShell>{children}</AppShell>
    </SessionGate>
  );
}
