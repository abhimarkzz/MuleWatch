import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

export class SupabaseConfigError extends Error {
  constructor() {
    super(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in frontend/.env.local."
    );
    this.name = "SupabaseConfigError";
  }
}

/**
 * Browser client using the publishable key only. Created on first use so a
 * missing variable surfaces as an on-screen configuration error rather than
 * crashing module evaluation during prerendering.
 */
export function getSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) throw new SupabaseConfigError();

  browserClient = createClient(url, key);
  return browserClient;
}
