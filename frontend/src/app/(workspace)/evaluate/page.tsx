import type { Metadata } from "next";
import { EvaluateTransaction } from "@/components/evaluate/EvaluateTransaction";

// Rendered after the client-side session check; see the workspace layout.
export const instant = false;

export const metadata: Metadata = { title: "Evaluate" };

export default function EvaluatePage() {
  return <EvaluateTransaction />;
}
