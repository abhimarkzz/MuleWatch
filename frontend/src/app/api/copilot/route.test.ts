import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  create: vi.fn(),
  groqOptions: vi.fn(),
  alertResult: { data: null as unknown, error: null as unknown },
  txResults: [] as Array<{ data: unknown; error: unknown }>,
  calls: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
}));

vi.mock("@/lib/server/auth", () => ({ authenticateRequest: mocks.authenticate }));

vi.mock("groq-sdk", () => {
  class APIError extends Error {
    constructor(readonly status?: number) {
      super("provider error");
    }
  }
  class RateLimitError extends APIError {}
  class APIConnectionTimeoutError extends APIError {}
  class Groq {
    chat = { completions: { create: mocks.create } };
    constructor(options: unknown) {
      mocks.groqOptions(options);
    }
  }
  return { default: Groq, APIError, RateLimitError, APIConnectionTimeoutError };
});

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const record = { table, ops: [] as Array<[string, unknown[]]> };
      mocks.calls.push(record);
      const result = table === "alerts" ? mocks.alertResult : mocks.txResults.shift() ?? { data: [], error: null };
      const builder: Record<string, unknown> = {
        maybeSingle: () => Promise.resolve(result),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, fail),
      };
      for (const op of ["select", "eq", "gt", "lt", "neq", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          record.ops.push([op, args]);
          return builder;
        };
      }
      return builder;
    },
  }),
}));

import { POST } from "./route";
import * as groq from "groq-sdk";

// The mocked classes take only a status; the real constructors differ.
type MockError = new (status?: number) => Error;
const RateLimitError = groq.RateLimitError as unknown as MockError;
const APIConnectionTimeoutError = groq.APIConnectionTimeoutError as unknown as MockError;
const APIError = groq.APIError as unknown as MockError;
import { parseBullets, SYSTEM_PROMPT } from "@/lib/server/copilot-prompt";

const ALERT_ID = "11111111-2222-4333-8444-555555555555";
const SENDER = "aaaaaaaa-0000-4000-8000-000000000001";
const RECEIVER = "bbbbbbbb-0000-4000-8000-000000000002";

const SEED = {
  id: "tx-seed",
  source_account_id: SENDER,
  destination_account_id: RECEIVER,
  transaction_type: "TRANSFER",
  amount: "9000",
  transaction_step: 100,
  model_score: 0.93,
  predicted_is_fraud: true,
};

const tx = (id: string, from: string, to: string, step: number) => ({ ...SEED, id, source_account_id: from, destination_account_id: to, transaction_step: step, predicted_is_fraud: false });

const GOOD = "- SENDER moved 9000 to RECEIVER.\n- Layering observed: RECEIVER forwarded funds 3 hours later.\n- Fan-out not observed; evidence is limited and fraud is not proven.";

function call(body: unknown = { alert_id: ALERT_ID }) {
  return POST(
    new Request("https://mulewatch.test/api/copilot", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer t" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/copilot", () => {
  beforeEach(() => {
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("GROQ_MODEL", "");
    mocks.authenticate.mockResolvedValue({ ok: true, user: { id: "u", email: "a@test" } });
    mocks.alertResult = {
      data: { id: ALERT_ID, severity: "critical", status: "open", risk_score: 0.93, reason: "Model flag", transaction: SEED },
      error: null,
    };
    mocks.txResults = [
      { data: [tx("tx-on", RECEIVER, "cccccccc-0000-4000-8000-000000000003", 103)], error: null },
      { data: [tx("tx-fan", SENDER, "dddddddd-0000-4000-8000-000000000004", 90)], error: null },
    ];
    mocks.calls = [];
    mocks.create.mockResolvedValue({ choices: [{ message: { content: GOOD } }] });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires analyst authentication and never calls Groq without it", async () => {
    mocks.authenticate.mockResolvedValueOnce({ ok: false, response: Response.json({ error: "no" }, { status: 401 }) });
    expect((await call()).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.calls).toHaveLength(0);
  });

  it("returns 503 when GROQ_API_KEY is missing", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    expect((await call()).status).toBe(503);
  });

  it.each([[{ alert_id: "abc" }], [{ alert_id: 5 }], [{}], [null], ["{bad"]])("rejects invalid input %j with 400", async (body) => {
    expect((await call(body)).status).toBe(400);
    expect(mocks.calls).toHaveLength(0);
  });

  it("returns 404 for an unknown alert and 500 on a database error", async () => {
    mocks.alertResult = { data: null, error: null };
    expect((await call()).status).toBe(404);
    mocks.alertResult = { data: null, error: { message: "db down" } };
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });

  it("returns 422 when the alert has no graph to analyse", async () => {
    mocks.alertResult = { data: { id: ALERT_ID, transaction: null }, error: null };
    expect((await call()).status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns 500 when a graph query fails", async () => {
    mocks.txResults = [{ data: null, error: { message: "x" } }, { data: [], error: null }];
    expect((await call()).status).toBe(500);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("builds the 24-hour two-hop graph server-side and returns three bullets", async () => {
    const res = await call({ alert_id: ALERT_ID, graph: { nodes: ["injected"] } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bullets).toHaveLength(3);
    expect(body.observed).toEqual({
      sender_distinct_receivers_in_window: 2,
      onward_transfers_from_receiver: 1,
      layering_chain_observed: true,
      truncated: false,
    });
    expect(body.model).toBe("openai/gpt-oss-20b");

    // Temporal predicates: onward strictly after and < 24 h; sender ±24 h.
    const [, onward, fan] = mocks.calls;
    expect(onward.ops).toEqual(expect.arrayContaining([["eq", ["source_account_id", RECEIVER]], ["gt", ["transaction_step", 100]], ["lt", ["transaction_step", 124]]]));
    expect(fan.ops).toEqual(expect.arrayContaining([["eq", ["source_account_id", SENDER]], ["gt", ["transaction_step", 76]], ["lt", ["transaction_step", 124]]]));

    const request = mocks.create.mock.calls[0][0];
    expect(request.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(request.max_completion_tokens).toBeLessThanOrEqual(400);
    const sent = request.messages[1].content as string;
    // Opaque labels only; no account UUIDs, record IDs or browser-supplied graph.
    for (const leak of [SENDER, RECEIVER, "tx-seed", "injected", ALERT_ID]) expect(sent).not.toContain(leak);
    expect(JSON.parse(sent).edges.map((e: { hours_after_flagged: number }) => e.hours_after_flagged)).toEqual([0, 3, -10]);
    expect(mocks.groqOptions).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "test-groq-key", timeout: 20_000 }));
  });

  it("asks gpt-oss models for low, hidden reasoning", async () => {
    await call();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-oss-20b", reasoning_effort: "low", include_reasoning: false });
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("reasoning_format");
  });

  it("sends no reasoning options to other models", async () => {
    vi.stubEnv("GROQ_MODEL", "llama-3.1-8b-instant");
    await call();
    const request = mocks.create.mock.calls[0][0];
    expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).not.toHaveProperty("include_reasoning");
  });

  it("uses GROQ_MODEL when set", async () => {
    vi.stubEnv("GROQ_MODEL", "llama-3.1-8b-instant");
    await call();
    expect(mocks.create.mock.calls[0][0].model).toBe("llama-3.1-8b-instant");
  });

  it("still reports when the graph has only the flagged transfer", async () => {
    mocks.txResults = [{ data: [], error: null }, { data: [], error: null }];
    const body = await (await call()).json();
    expect(body.transactions_analysed).toBe(1);
    expect(body.observed.layering_chain_observed).toBe(false);
  });

  it.each([
    ["prose instead of bullets", { choices: [{ message: { content: "Looks suspicious." } }] }],
    ["four bullets", { choices: [{ message: { content: "- a\n- b\n- c\n- d" } }] }],
    ["no choices", { choices: [] }],
    ["null content", { choices: [{ message: { content: null } }] }],
  ])("returns 502 for a malformed provider response (%s)", async (_label, completion) => {
    mocks.create.mockResolvedValueOnce(completion);
    const res = await call();
    expect(res.status).toBe(502);
    expect((await res.json()).retryable).toBe(true);
  });

  it.each([
    ["rate limit", () => new RateLimitError(429), 429],
    ["timeout", () => new APIConnectionTimeoutError(), 504],
    ["provider error", () => new APIError(500), 502],
    ["bad key", () => new APIError(401), 502],
    ["unknown failure", () => new Error("boom test-groq-key"), 502],
  ])("maps a %s to a safe %i", async (_label, makeError, status) => {
    mocks.create.mockRejectedValueOnce(makeError());
    const res = await call();
    expect(res.status).toBe(status);
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(JSON.stringify(await res.json()) + logged).not.toMatch(/test-groq-key|TRANSFER|9000/);
  });
});

describe("parseBullets", () => {
  it("accepts dash, star, bullet and numbered lists of exactly three", () => {
    expect(parseBullets("- a\n- b\n- c")).toEqual(["a", "b", "c"]);
    expect(parseBullets("Summary:\n* a\n• b\n3. c")).toEqual(["a", "b", "c"]);
    expect(parseBullets("- a\n- b")).toBeNull();
    expect(parseBullets(42)).toBeNull();
  });

  it("caps very long bullets", () => {
    const [first] = parseBullets(`- ${"x".repeat(900)}\n- b\n- c`)!;
    expect(first.length).toBe(400);
  });
});
