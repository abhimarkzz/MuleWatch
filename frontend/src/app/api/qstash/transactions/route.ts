import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { POST as predictPost } from "@/app/api/predict/route";

// Forwarding waits on /api/predict, which allows 90 s for a Render cold start.
export const maxDuration = 120;

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function reply(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * A signed message that can never succeed. QStash treats 489 with this header
 * as final and moves the message to its DLQ instead of retrying.
 */
function permanentFailure(error: string, body?: BodyInit) {
  const headers = { ...NO_STORE, "Content-Type": "application/json", "Upstash-NonRetryable-Error": "true" };
  return new NextResponse(body ?? JSON.stringify({ error }), { status: 489, headers });
}

/** QStash message IDs are stable across retries of the same message. */
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * The URL QStash signed. Behind a proxy `request.url` can be an internal
 * address, so QSTASH_RECEIVER_URL may pin the public one.
 */
function signedUrl(request: Request): string {
  return process.env.QSTASH_RECEIVER_URL?.trim() || request.url;
}

/**
 * QStash delivery endpoint for transactions. The body is verified against the
 * Upstash-Signature JWT before it is parsed; a verified event is then scored by
 * the /api/predict handler in-process, authenticated with MULEWATCH_API_KEY.
 * Nothing from the payload, headers or keys is logged.
 */
export async function POST(request: Request) {
  const apiKey = process.env.MULEWATCH_API_KEY;
  if (
    !process.env.QSTASH_CURRENT_SIGNING_KEY ||
    !process.env.QSTASH_NEXT_SIGNING_KEY ||
    !apiKey
  ) {
    return reply(503, "QStash receiver is not configured.");
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) return reply(401, "Missing QStash signature.");

  // The signature covers the exact bytes sent, so read the raw text once.
  const body = await request.text();

  // Keys come from the environment so the SDK can choose region-specific
  // keys (QSTASH_REGION + upstash-region header) when they are configured.
  // devMode is off so a QSTASH_DEV variable can never relax verification.
  const receiver = new Receiver({ devMode: false });
  let verified = false;
  try {
    verified = await receiver.verify({
      signature,
      body,
      url: signedUrl(request),
      upstashRegion: request.headers.get("upstash-region") ?? undefined,
    });
  } catch {
    verified = false;
  }
  if (!verified) return reply(401, "Invalid QStash signature.");

  // Everything below is a verified message, so a bad body is permanent.
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return permanentFailure("Message body is too large.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return permanentFailure("Message body must be valid JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return permanentFailure("Message body must be a JSON object.");
  }

  // Idempotency: /api/predict upserts on external_transaction_id (unique) and
  // the alerts (transaction_id, reason) unique index stops duplicate alerts.
  // Without an ID the handler would mint a random one per delivery, so a
  // retried message would be stored twice; derive it from the message ID.
  let forwardedBody = body;
  if (!("external_transaction_id" in payload)) {
    const messageId = request.headers.get("upstash-message-id") ?? "";
    if (!MESSAGE_ID.test(messageId)) {
      return permanentFailure("Message needs an external_transaction_id or a valid Upstash-Message-Id.");
    }
    forwardedBody = JSON.stringify({ ...payload, external_transaction_id: `qstash-${messageId}` });
  }

  // The prediction handler re-validates every field.
  const forwarded = new Request(new URL("/api/predict", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: forwardedBody,
  });

  let response: Response;
  try {
    response = await predictPost(forwarded);
  } catch {
    console.error("QStash transaction could not be scored.");
    return reply(502, "The transaction could not be scored.");
  }

  // The handler answers 400 only for field validation, which a retry cannot
  // fix. Every other status passes through: 5xx (model or database outage,
  // timeouts) stays retryable. Its bodies hold no stack traces or credentials.
  if (response.status === 400) {
    return permanentFailure("", await response.text());
  }
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}
