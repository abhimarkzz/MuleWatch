import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) },
  }),
}));

import { ApiError, apiRequest } from "./api-client";
import { interpretEvaluation } from "./evaluation";

const QUEUED = {
  status: "queued",
  prediction: "pending",
  external_transaction_id: "mulewatch-ui-1",
  topic: "raw-transactions",
  partition: 0,
  offset: "12",
};

describe("interpretEvaluation", () => {
  it("treats a queued response as pending, never as a score", () => {
    const outcome = interpretEvaluation(QUEUED);
    expect(outcome).toEqual({ kind: "queued", queued: QUEUED });
    expect(outcome).not.toHaveProperty("prediction");
  });

  it("still understands a synchronous prediction", () => {
    const prediction = { predicted_is_fraud: true, fraud_probability: 0.9, external_transaction_id: "x" };
    expect(interpretEvaluation(prediction)).toEqual({ kind: "scored", prediction });
  });

  it.each([null, "queued", {}, { status: "queued" }, { status: "queued", prediction: "pending" }, { predicted_is_fraud: "yes" }])(
    "rejects an unexpected body %#",
    (body) => {
      expect(() => interpretEvaluation(body)).toThrow(ApiError);
    },
  );
});

describe("queue responses through apiRequest", () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => vi.unstubAllGlobals());

  const send = () => apiRequest<unknown>("/api/transactions/queue", { method: "POST", body: { amount: 1 } });

  it("returns the 202 body, sending the analyst's token", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(QUEUED, { status: 202 }));
    expect(interpretEvaluation(await send()).kind).toBe("queued");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/transactions/queue");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("surfaces a broker outage as a retryable error", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "The transaction queue is unavailable. Please retry.", retryable: true }, { status: 503 }),
    );
    await expect(send()).rejects.toMatchObject({
      status: 503,
      retryable: true,
      message: "The transaction queue is unavailable. Please retry.",
    });
  });

  it("surfaces a validation failure as non-retryable", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Invalid transaction type." }, { status: 400 }));
    await expect(send()).rejects.toMatchObject({ status: 400, retryable: false, message: "Invalid transaction type." });
  });
});

describe("Evaluate page submission path", () => {
  const source = readFileSync(path.resolve(__dirname, "../components/evaluate/EvaluateTransaction.tsx"), "utf8");

  it("queues through /api/transactions/queue and no longer calls /api/predict", () => {
    expect(source).toContain('"/api/transactions/queue"');
    expect(source).not.toContain('"/api/predict"');
    expect(source).toContain("interpretEvaluation(");
  });
});
