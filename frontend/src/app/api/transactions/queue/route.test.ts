import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  kafkaConfig: vi.fn(),
  connect: vi.fn(),
  send: vi.fn(),
  disconnect: vi.fn(),
  producerOptions: vi.fn(),
  authenticate: vi.fn(),
  after: vi.fn(),
}));

vi.mock("kafkajs", () => ({
  logLevel: { NOTHING: 0 },
  Kafka: class {
    constructor(config: unknown) {
      mocks.kafkaConfig(config);
    }
    producer(options: unknown) {
      mocks.producerOptions(options);
      return { connect: mocks.connect, send: mocks.send, disconnect: mocks.disconnect };
    }
  },
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));

vi.mock("@/lib/server/auth", () => ({
  bearerToken: (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
  authenticateRequest: mocks.authenticate,
}));

import { POST } from "./route";
import { POST as predictPost } from "../../predict/route";
import { resetProducer } from "@/lib/server/kafka";

const VALID = {
  step: 1,
  type: "TRANSFER",
  amount: 100,
  oldbalanceOrg: 100,
  oldbalanceDest: 0,
  orig_txn_count_before: 0,
  dest_txn_count_before: 0,
  dest_is_merchant: 0,
  external_transaction_id: "ext-1",
};

function call(body: unknown, headers: Record<string, string> = { "x-api-key": "test-api-key" }) {
  return POST(
    new Request("https://mulewatch.test/api/transactions/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/transactions/queue", () => {
  beforeEach(async () => {
    await resetProducer();
    vi.stubEnv("MULEWATCH_API_KEY", "test-api-key");
    vi.stubEnv("KAFKA_BROKERS", "broker-1.test:12345, broker-2.test:12345");
    vi.stubEnv("KAFKA_USERNAME", "test-user");
    vi.stubEnv("KAFKA_PASSWORD", "test-password");
    vi.stubEnv("KAFKA_TOPIC", "raw-transactions");
    vi.stubEnv("KAFKA_SASL_MECHANISM", "");
    vi.stubEnv("KAFKA_CA_CERT", "");
    mocks.connect.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue([{ topicName: "raw-transactions", partition: 2, baseOffset: "41" }]);
    mocks.authenticate.mockResolvedValue({ ok: true, user: { id: "u1", email: "a@test" } });
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("authorization", () => {
    it("rejects a request with no credentials", async () => {
      expect((await call(VALID, {})).status).toBe(401);
      expect(mocks.send).not.toHaveBeenCalled();
    });

    it("rejects a wrong API key without a session", async () => {
      expect((await call(VALID, { "x-api-key": "wrong" })).status).toBe(401);
    });

    it("passes through the session check's rejection", async () => {
      mocks.authenticate.mockResolvedValueOnce({ ok: false, response: Response.json({ error: "no" }, { status: 403 }) });
      expect((await call(VALID, { authorization: "Bearer t" })).status).toBe(403);
      expect(mocks.send).not.toHaveBeenCalled();
    });

    it("accepts a signed-in analyst", async () => {
      expect((await call(VALID, { authorization: "Bearer t" })).status).toBe(202);
    });
  });

  it.each(["KAFKA_BROKERS", "KAFKA_USERNAME", "KAFKA_PASSWORD"])("returns 503 when %s is missing", async (name) => {
    vi.stubEnv(name, "");
    expect((await call(VALID)).status).toBe(503);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("returns 503 for an unsupported SASL mechanism", async () => {
    vi.stubEnv("KAFKA_SASL_MECHANISM", "gssapi");
    expect((await call(VALID)).status).toBe(503);
  });

  it.each([
    ["malformed JSON", "{nope", "Request body must be valid JSON."],
    ["an array", [1], "Request body must be a JSON object."],
    ["a bad type", { ...VALID, type: "BITCOIN" }, "Invalid transaction type."],
    ["a missing field", { ...VALID, amount: undefined }, "All numeric fields must contain valid numbers."],
    ["a negative amount", { ...VALID, amount: -1 }, "One or more transaction fields are invalid."],
    ["a fractional step", { ...VALID, step: 1.5 }, "One or more transaction fields are invalid."],
    ["an empty ID", { ...VALID, external_transaction_id: "" }, "One or more transaction fields are invalid."],
  ])("rejects %s with 400 and publishes nothing", async (_label, body, error) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body", async () => {
    expect((await call("x".repeat(70_000))).status).toBe(413);
  });

  it("publishes with TLS, SASL/PLAIN, acks=all and idempotence, then returns 202", async () => {
    const res = await call(VALID);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: "queued",
      prediction: "pending",
      external_transaction_id: "ext-1",
      topic: "raw-transactions",
      partition: 2,
      offset: "41",
    });

    expect(mocks.kafkaConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        brokers: ["broker-1.test:12345", "broker-2.test:12345"],
        ssl: true,
        sasl: { mechanism: "plain", username: "test-user", password: "test-password" },
      }),
    );
    expect(mocks.producerOptions).toHaveBeenCalledWith(expect.objectContaining({ idempotent: true, maxInFlightRequests: 1 }));

    const sent = mocks.send.mock.calls[0][0];
    expect(sent).toMatchObject({ topic: "raw-transactions", acks: -1 });
    expect(sent.messages[0].key).toBe("ext-1");
    expect(JSON.parse(sent.messages[0].value)).toEqual(VALID);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("uses the Aiven CA certificate when provided", async () => {
    vi.stubEnv("KAFKA_CA_CERT", "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----");
    await call(VALID);
    expect(mocks.kafkaConfig.mock.calls[0][0].ssl).toEqual({
      ca: ["-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"],
      rejectUnauthorized: true,
    });
  });

  it("assigns an ID when the payload has none and uses it as the key", async () => {
    const { external_transaction_id: _omit, ...withoutId } = VALID;
    void _omit;
    const res = await call(withoutId);
    const id = (await res.json()).external_transaction_id;
    expect(id).toMatch(/^mulewatch-[0-9a-f-]{36}$/);
    const message = mocks.send.mock.calls[0][0].messages[0];
    expect(message.key).toBe(id);
    expect(JSON.parse(message.value).external_transaction_id).toBe(id);
  });

  it("reuses one connection across requests", async () => {
    await call(VALID);
    await call(VALID);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("returns 503 without credentials or broker details when the broker fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.send.mockRejectedValueOnce(Object.assign(new Error("connect to broker-1.test:12345 failed"), { name: "KafkaJSConnectionError" }));
    const res = await call(VALID);
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json()) + JSON.stringify(log.mock.calls);
    expect(text).not.toMatch(/broker-1|test-password|test-user/);
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();

    // The next request reconnects instead of reusing the broken producer.
    await call(VALID);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("returns 503 when the connection itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.connect.mockRejectedValueOnce(new Error("SASL authentication failed"));
    expect((await call(VALID)).status).toBe(503);
  });
});

describe("validation parity with /api/predict", () => {
  beforeEach(() => {
    vi.stubEnv("MULEWATCH_API_KEY", "test-api-key");
    vi.stubEnv("KAFKA_BROKERS", "broker-1.test:12345");
    vi.stubEnv("KAFKA_USERNAME", "test-user");
    vi.stubEnv("KAFKA_PASSWORD", "test-password");
  });
  afterEach(() => vi.unstubAllEnvs());

  const cases: unknown[] = [
    [1],
    { ...VALID, type: "BITCOIN" },
    { ...VALID, amount: "100" },
    { ...VALID, amount: -1 },
    { ...VALID, step: 1.5 },
    { ...VALID, dest_is_merchant: 2 },
    { ...VALID, external_transaction_id: "x".repeat(151) },
    { ...VALID, source_account_external_id: "" },
  ];

  it.each(cases.map((c, i) => [i, c]))("case %i gets the same 400 message from both routes", async (_i, body) => {
    const request = () =>
      new Request("https://mulewatch.test/x", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-api-key" },
        body: JSON.stringify(body),
      });
    const [queued, predicted] = await Promise.all([POST(request()), predictPost(request())]);
    expect(queued.status).toBe(400);
    expect(predicted.status).toBe(400);
    expect((await queued.json()).error).toBe((await predicted.json()).error);
  });
});
