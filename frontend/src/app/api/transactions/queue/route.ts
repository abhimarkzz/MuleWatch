import { after, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { authenticateRequest, bearerToken } from "@/lib/server/auth";
import { getProducer, readKafkaConfig, resetProducer } from "@/lib/server/kafka";
import { validateTransaction } from "@/lib/server/transaction-validation";

export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 64 * 1024;
const RENDER_API_URL = (process.env.RENDER_API_URL ?? "https://mulewatch.onrender.com").replace(/\/+$/, "");

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function validApiKey(request: Request): boolean {
  const expected = process.env.MULEWATCH_API_KEY;
  const supplied = request.headers.get("x-api-key");
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Queues a transaction on Kafka for asynchronous scoring by the FastAPI
 * consumer. Same callers as /api/predict: a server holding MULEWATCH_API_KEY
 * or a signed-in analyst. 202 means the broker acknowledged the message
 * (acks=all); the prediction has NOT run yet.
 */
export async function POST(request: Request) {
  if (!validApiKey(request)) {
    if (!bearerToken(request)) return reply(401, { error: "Unauthorized. Please sign in and retry." });
    const auth = await authenticateRequest(request);
    if (!auth.ok) return auth.response;
  }

  const config = readKafkaConfig();
  if (!config) return reply(503, { error: "Transaction queue is not configured." });

  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return reply(413, { error: "Request body is too large." });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply(400, { error: "Request body must be valid JSON." });
  }
  const result = validateTransaction(raw);
  if (!result.ok) return reply(400, { error: result.error });

  // The ID is the Kafka key (same-ID messages share a partition, so they stay
  // ordered) and the database idempotency key: /api/predict upserts on it.
  const transaction = {
    ...result.transaction,
    external_transaction_id: result.transaction.external_transaction_id ?? `mulewatch-${crypto.randomUUID()}`,
  };

  let metadata;
  try {
    const producer = await getProducer(config);
    [metadata] = await producer.send({
      topic: config.topic,
      acks: -1,
      timeout: 10_000,
      messages: [
        {
          key: transaction.external_transaction_id,
          value: JSON.stringify(transaction),
          headers: { "content-type": "application/json", source: "mulewatch-frontend" },
        },
      ],
    });
  } catch (error) {
    await resetProducer();
    // Error names only: KafkaJS messages can include broker hostnames.
    console.error("Kafka publish failed:", error instanceof Error ? error.name : "unknown error");
    return reply(503, { error: "The transaction queue is unavailable. Please retry.", retryable: true });
  }

  // Best effort: an inbound request wakes a sleeping Render Free service, and
  // its consumer then drains the topic. Runs after the response is sent, so a
  // cold start never delays this request.
  after(async () => {
    try {
      await fetch(`${RENDER_API_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    } catch {
      // Render may still be booting; the request already started it.
    }
  });

  return reply(202, {
    status: "queued",
    prediction: "pending",
    external_transaction_id: transaction.external_transaction_id,
    topic: metadata?.topicName ?? config.topic,
    partition: metadata?.partition ?? null,
    offset: metadata?.baseOffset ?? null,
  });
}
