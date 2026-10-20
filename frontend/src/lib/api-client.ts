import { getSupabase } from "@/lib/supabase";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

async function accessToken(): Promise<string> {
  const { data, error } = await getSupabase().auth.getSession();

  if (error || !data.session) {
    throw new ApiError("Your session has ended. Please sign in again.", 401, false);
  }

  return data.session.access_token;
}

/**
 * Calls a MuleWatch route handler with the analyst's Supabase token.
 * Normalises network failures, timeouts and non-JSON bodies into ApiError so
 * every screen can render the same recoverable error state. A 401 is
 * broadcast so the session guard can return the user to sign-in.
 */
export async function apiRequest<T>(
  path: string,
  { method = "GET", body, signal, timeoutMs = DEFAULT_TIMEOUT_MS }: ApiOptions = {}
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError("You appear to be offline. Reconnect and retry.", 0, true);
  }

  const token = await accessToken();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;

  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: combined,
    });
  } catch (error) {
    // Caller-initiated cancellation is not an error worth showing.
    if (signal?.aborted) throw error;

    if (timeout.aborted) {
      throw new ApiError(
        `The request did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
        0,
        true,
        "TIMEOUT"
      );
    }

    throw new ApiError("The MuleWatch server could not be reached.", 0, true);
  }

  const payload = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; retryable?: boolean; code?: string })
    | null;

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("mulewatch:unauthorized"));
    }

    throw new ApiError(
      typeof payload?.error === "string"
        ? payload.error
        : `The request failed with status ${response.status}.`,
      response.status,
      payload?.retryable ?? (response.status >= 500 || response.status === 429),
      payload?.code
    );
  }

  if (payload === null) {
    throw new ApiError("The server returned an unreadable response.", response.status, true);
  }

  return payload as T;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
