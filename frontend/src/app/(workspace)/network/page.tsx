import type { Metadata } from "next";
import { Suspense } from "react";
import { PageFallback } from "@/components/ui";
import { NetworkExplorer } from "@/components/network/NetworkExplorer";

// Rendered after the client-side session check; see the workspace layout.
export const instant = false;

export const metadata: Metadata = { title: "Network" };

export default function NetworkPage() {
  return (
    <Suspense fallback={<PageFallback title="Network explorer" />}>
      <NetworkExplorer />
    </Suspense>
  );
}
