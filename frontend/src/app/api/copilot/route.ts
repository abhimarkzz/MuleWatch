import { NextResponse } from "next/server";
import Groq, { APIConnectionTimeoutError, APIError, RateLimitError } from "groq-sdk";
import { authenticateRequest } from "@/lib/server/auth";
import { buildCopilotGraph } from "@/lib/server/copilot-graph";
import { parseBullets, SYSTEM_PROMPT } from "@/lib/server/copilot-prompt";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 30;

// A Groq production model (console.groq.com/docs/models); GROQ_MODEL overrides.
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 400;
const MAX_INPUT_CHARS = 12_000;
const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * Analyst Copilot: explains one alert's temporal two-hop network. The graph
 * is built server-side from the alert ID; only opaque labels, amounts, types,
 * relative hours and model scores are sent to Groq.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return reply(503, { error: "The AI report is not configured." });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(400, { error: "Request body must be valid JSON." });
  }
  const alertId = (body as { alert_id?: unknown } | null)?.alert_id;
  if (typeof alertId !== "string" || !UUID.test(alertId)) {
    return reply(400, { error: "alert_id must be an alert UUID." });
  }

  const built = await buildCopilotGraph(getSupabaseAdmin(), alertId);
  if (!built.ok) return reply(built.status, { error: built.error });

  const input = JSON.stringify(built.graph);
  if (input.length > MAX_INPUT_CHARS) return reply(422, { error: "The network is too large to summarise." });

  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const groq = new Groq({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });

  let content: unknown;
  try {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.2,
      // gpt-oss models reason before answering. Keep that short and out of the
      // reply so the three bullets survive; Groq rejects reasoning_format for
      // these models, so include_reasoning is the supported switch.
      ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" as const, include_reasoning: false } : {}),
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
    });
    content = completion.choices?.[0]?.message?.content;
  } catch (error) {
    // Class name and status only: provider errors can echo request content.
    const status = error instanceof APIError ? error.status : undefined;
    console.error("Copilot provider call failed:", error instanceof Error ? error.constructor.name : "unknown", status ?? "");

    if (error instanceof RateLimitError) {
      return reply(429, { error: "The AI service is busy. Try again in a minute.", retryable: true });
    }
    if (error instanceof APIConnectionTimeoutError) {
      return reply(504, { error: "The AI service did not respond in time. Please retry.", retryable: true });
    }
    return reply(502, { error: "The AI service could not produce a report. Please retry later.", retryable: true });
  }

  const bullets = parseBullets(content);
  if (!bullets) {
    return reply(502, { error: "The AI service returned an unusable report. Please retry.", retryable: true });
  }

  return reply(200, {
    alert_id: alertId,
    model,
    bullets,
    observed: built.graph.observed,
    window_hours: built.graph.window_hours,
    transactions_analysed: built.graph.edges.length,
    generated_at: new Date().toISOString(),
    disclaimer: "AI-generated summary of the supplied data. It is not a finding of fraud.",
  });
}
