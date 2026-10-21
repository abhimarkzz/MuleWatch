import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  receiverConfig: vi.fn(),
  predict: vi.fn(),
}));

vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    constructor(config: unknown) {
      mocks.receiverConfig(config);
    }
    verify = mocks.verify;
  },
}));

vi.mock("@/app/api/predict/route", () => ({ POST: mocks.predict }));

import { POST } from "./route";

const URL_ = "https://mulewatch.test/api/qstash/transactions";
const BODY = JSON.stringify({ step: 1, type: "PAYMENT", amount: 10, external_transaction_id: "ext-1" });

function message(body: string = BODY, headers: Record<string, string> = { "upstash-signature": "sig" }) {
  return new Request(URL_, { method: "POST", headers, body });
}

describe("POST /api/qstash/transactions", () => {
  beforeEach(() => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "test-current");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "test-next");
    vi.stubEnv("MULEWATCH_API_KEY", "test-api-key");
    vi.stubEnv("QSTASH_RECEIVER_URL", "");
    mocks.verify.mockResolvedValue(true);
    mocks.predict.mockResolvedValue(Response.json({ transaction_id: "t1" }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "MULEWATCH_API_KEY"])(
    "returns 503 when %s is missing",
    async (name) => {
      vi.stubEnv(name, "");
      const res = await POST(message());
      expect(res.status).toBe(503);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.predict).not.toHaveBeenCalled();
    },
  );

  it("returns 401 without a signature", async () => {
    const res = await POST(message(BODY, {}));
    expect(res.status).toBe(401);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.predict).not.toHaveBeenCalled();
  });

  it("returns 401 when verification fails or throws", async () => {
    mocks.verify.mockResolvedValueOnce(false);
    expect((await POST(message())).status).toBe(401);
    mocks.verify.mockRejectedValueOnce(new Error("SignatureError"));
    expect((await POST(message())).status).toBe(401);
    expect(mocks.predict).not.toHaveBeenCalled();
  });

  it("verifies before parsing: an unsigned malformed body is 401, not 489", async () => {
    mocks.verify.mockResolvedValueOnce(false);
    expect((await POST(message("{not json"))).status).toBe(401);
  });

  function expectPermanent(res: Response) {
    expect(res.status).toBe(489);
    expect(res.headers.get("upstash-nonretryable-error")).toBe("true");
  }

  it("returns non-retryable 489 for malformed JSON or a non-object after verification", async () => {
    expectPermanent(await POST(message("{not json")));
    expectPermanent(await POST(message("[1,2]")));
    expect(mocks.predict).not.toHaveBeenCalled();
  });

  it("returns 489 for a signed oversized body and 401 for an unsigned one", async () => {
    expectPermanent(await POST(message("x".repeat(70_000))));
    mocks.verify.mockResolvedValueOnce(false);
    expect((await POST(message("x".repeat(70_000)))).status).toBe(401);
    expect(mocks.predict).not.toHaveBeenCalled();
  });

  it("maps a handler validation 400 to non-retryable 489, keeping its body", async () => {
    mocks.predict.mockResolvedValueOnce(Response.json({ error: "Invalid transaction type." }, { status: 400 }));
    const res = await POST(message());
    expectPermanent(res);
    expect(await res.json()).toEqual({ error: "Invalid transaction type." });
  });

  it.each([502, 503, 504])("keeps a handler %s retryable (no non-retryable header)", async (status) => {
    mocks.predict.mockResolvedValueOnce(Response.json({ error: "x", retryable: true }, { status }));
    const res = await POST(message());
    expect(res.status).toBe(status);
    expect(res.headers.get("upstash-nonretryable-error")).toBeNull();
  });

  it("derives a stable external_transaction_id from the QStash message ID", async () => {
    const body = JSON.stringify({ step: 1, type: "PAYMENT", amount: 10 });
    const headers = { "upstash-signature": "sig", "upstash-message-id": "msg_abc-123" };
    await POST(message(body, headers));
    await POST(message(body, { ...headers, "upstash-retried": "1" }));
    const ids = await Promise.all(
      mocks.predict.mock.calls.map(async (call) => (await (call[0] as Request).json()).external_transaction_id),
    );
    expect(ids).toEqual(["qstash-msg_abc-123", "qstash-msg_abc-123"]);
  });

  it("rejects a message with neither an ID nor a usable message ID as permanent", async () => {
    const body = JSON.stringify({ step: 1, type: "PAYMENT", amount: 10 });
    expectPermanent(await POST(message(body)));
    expectPermanent(await POST(message(body, { "upstash-signature": "sig", "upstash-message-id": "bad id!" })));
    expect(mocks.predict).not.toHaveBeenCalled();
  });

  it("verifies the raw body, URL and region, then forwards the original payload", async () => {
    const res = await POST(message(BODY, { "upstash-signature": "sig", "upstash-region": "EU-CENTRAL-1" }));

    expect(mocks.receiverConfig).toHaveBeenCalledWith({ devMode: false });
    expect(mocks.verify).toHaveBeenCalledWith({ signature: "sig", body: BODY, url: URL_, upstashRegion: "EU-CENTRAL-1" });

    const forwarded: Request = mocks.predict.mock.calls[0][0];
    expect(forwarded.url).toBe("https://mulewatch.test/api/predict");
    expect(forwarded.headers.get("x-api-key")).toBe("test-api-key");
    expect(await forwarded.text()).toBe(BODY);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ transaction_id: "t1" });
  });

  it("uses QSTASH_RECEIVER_URL as the signed URL when set", async () => {
    vi.stubEnv("QSTASH_RECEIVER_URL", "https://public.example/api/qstash/transactions");
    await POST(message());
    expect(mocks.verify.mock.calls[0][0].url).toBe("https://public.example/api/qstash/transactions");
  });

  it("propagates downstream failure statuses", async () => {
    mocks.predict.mockResolvedValueOnce(Response.json({ error: "busy", retryable: true }, { status: 503 }));
    const res = await POST(message());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "busy", retryable: true });
  });

  it("returns 502 without leaking details when the handler throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.predict.mockRejectedValueOnce(new Error("secret detail"));
    const res = await POST(message());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("PAYMENT");
  });
});
