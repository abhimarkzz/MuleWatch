import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const NO_STORE = { "Cache-Control": "no-store" };

/** Identity established from a verified access token. */
export type AuthenticatedUser = { id: string; email: string | undefined };

export type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: NextResponse };

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

function fail(status: number, error: string): AuthResult {
  return {
    ok: false,
    response: NextResponse.json({ error }, { status, headers: NO_STORE }),
  };
}

/**
 * Comma-separated MULEWATCH_ANALYST_EMAILS restricts data access to named
 * analysts. When unset, any user who can sign in to the Supabase project is
 * treated as an analyst — acceptable only if public sign-up is disabled.
 */
export function isAllowedAnalyst(email: string | undefined): boolean {
  const raw = process.env.MULEWATCH_ANALYST_EMAILS?.trim();
  if (!raw) return true;
  if (!email) return false;

  const allowed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return allowed.includes(email.toLowerCase());
}

function isAuthOutage(error: { name?: string; status?: number }): boolean {
  return (
    error.name === "AuthRetryableFetchError" ||
    (typeof error.status === "number" && (error.status === 0 || error.status >= 500))
  );
}

// One client per server process so the signing-key (JWKS) cache that
// getClaims relies on survives between requests.
let verifier: { key: string; client: SupabaseClient } | null = null;

function getVerifier(url: string, publicKey: string): SupabaseClient {
  const key = `${url}|${publicKey}`;
  if (verifier?.key !== key) {
    verifier = {
      key,
      client: createClient(url, publicKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      }),
    };
  }
  return verifier.client;
}

/**
 * Verifies the Supabase access token sent by the browser.
 *
 * Uses getClaims: with the project's asymmetric (ES256) signing key the
 * signature and expiry are checked locally against the cached public key, so
 * no Auth round trip is needed per request. (With a symmetric key, supabase-js
 * falls back to asking the Auth server.) Trade-off: a token revoked by
 * sign-out stays valid until it expires (one hour by default).
 */
export async function authenticateRequest(request: Request): Promise<AuthResult> {
  const token = bearerToken(request);

  if (!token) {
    return fail(401, "Authentication required. Please sign in.");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publicKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !publicKey) {
    console.error("Supabase authentication environment variables are missing.");
    return fail(500, "Authentication service is not configured.");
  }

  try {
    const { data, error } = await getVerifier(supabaseUrl, publicKey).auth.getClaims(token);

    // An unreachable auth server (e.g. while fetching signing keys) is an
    // outage, not a bad token: do not sign the analyst out for it.
    if (error && isAuthOutage(error)) {
      console.error("Supabase auth is unavailable:", error.message);
      return fail(503, "The authentication service could not be reached. Please retry.");
    }

    const claims = data?.claims;

    // Only signed-in users: anonymous or service tokens carry other roles.
    if (error || !claims?.sub || claims.role !== "authenticated") {
      return fail(401, "Your session is invalid or expired. Please sign in again.");
    }

    const email = typeof claims.email === "string" ? claims.email : undefined;

    if (!isAllowedAnalyst(email)) {
      return fail(403, "This account is not authorised to access MuleWatch data.");
    }

    return { ok: true, user: { id: claims.sub, email } };
  } catch (error) {
    console.error("Supabase token verification failed:", error);
    return fail(503, "The authentication service could not be reached.");
  }
}
