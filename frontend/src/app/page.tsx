import { redirect } from "next/navigation";

// Workspace pages send signed-out visitors to /login themselves.
export default function HomePage() {
  redirect("/alerts");
}
