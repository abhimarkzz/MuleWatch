import { redirect } from "next/navigation";

// The former single-page dashboard was split into Alerts, Network and Evaluate.
export default function DashboardPage() {
  redirect("/alerts");
}
