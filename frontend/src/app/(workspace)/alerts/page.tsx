import type { Metadata } from "next";
import { Suspense } from "react";
import { PageFallback } from "@/components/ui";
import { AlertQueue } from "@/components/alerts/AlertQueue";

// Rendered after the client-side session check; see the workspace layout.
export const instant = false;

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  // useSearchParams (filter state) needs a Suspense boundary.
  return (
    <Suspense fallback={<PageFallback title="Alert queue" />}>
      <AlertQueue />
    </Suspense>
  );
}
