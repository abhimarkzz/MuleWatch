import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redelivery through the real /api/predict handler. The database is an
 * in-memory fake that enforces the same unique keys as the project
 * (transactions.external_transaction_id; alerts (transaction_id, reason)).
 * It shows the code relies on those keys correctly; it does not prove the
 * keys exist in Postgres — see supabase/migrations/.
 */
type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  accounts: [] as Row[],
  transactions: [] as Row[],
  alerts: [] as Row[],
  failAlertInsert: false,
}));

vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = async () => true;
  },
}));

vi.mock("@/lib/server/auth", () => ({
  bearerToken: () => null,
  authenticateRequest: async () => ({ ok: false }),
}));

vi.mock("@/lib/supabase-admin", () => {
  const keyOf: Record<string, string> = {
    accounts: "external_account_id",
    transactions: "external_transaction_id",
  };
  let nextId = 0;

  function from(table: "accounts" | "transactions" | "alerts") {
    const rows = db[table];
    const filters: Array<[string, unknown]> = [];
    let result: { data: unknown; error: unknown } = { data: null, error: null };

    const builder = {
      upsert(row: Row) {
        const key = keyOf[table];
        const existing = rows.find((r) => r[key] === row[key]);
        if (existing) Object.assign(existing, row);
        else rows.push({ id: `${table}-${++nextId}`, created_at: "t", ...row });
        result = { data: rows.find((r) => r[key] === row[key]), error: null };
        return builder;
      },
      insert(row: Row) {
        if (db.failAlertInsert) {
          result = { data: null, error: { code: "08006", message: "connection failure" } };
        } else if (rows.some((r) => r.transaction_id === row.transaction_id && r.reason === row.reason)) {
          result = { data: null, error: { code: "23505", message: "duplicate key" } };
        } else {
          rows.push({ id: `${table}-${++nextId}`, ...row });
        }
        return builder;
      },
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      limit() {
        result = { data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null };
        return builder;
      },
      single() {
        return Promise.resolve(result);
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  }

  return { getSupabaseAdmin: () => ({ from }) };
});

import { POST } from "./route";

const EVENT = JSON.stringify({
  step: 1,
  type: "TRANSFER",
  amount: 9000,
  oldbalanceOrg: 9000,
  oldbalanceDest: 0,
  orig_txn_count_before: 0,
  dest_txn_count_before: 0,
  dest_is_merchant: 0,
  source_account_external_id: "C1",
  destination_account_external_id: "C2",
});

function deliver(attempt = 0) {
  return POST(
    new Request("https://mulewatch.test/api/qstash/transactions", {
      method: "POST",
      headers: {
        "upstash-signature": "sig",
        "upstash-message-id": "msg_redelivery_1",
        "upstash-retried": String(attempt),
      },
      body: EVENT,
    }),
  );
}

describe("QStash redelivery", () => {
  beforeEach(() => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "test-current");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "test-next");
    vi.stubEnv("MULEWATCH_API_KEY", "test-api-key");
    db.accounts.length = 0;
    db.transactions.length = 0;
    db.alerts.length = 0;
    db.failAlertInsert = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ predicted_is_fraud: true, fraud_probability: 0.95, model_version: "test" })),
    );
  });

  it("stores one transaction and one alert however often the message is delivered", async () => {
    const first = await deliver(0);
    const second = await deliver(1);
    const third = await deliver(2);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(db.transactions).toHaveLength(1);
    expect(db.transactions[0].external_transaction_id).toBe("qstash-msg_redelivery_1");
    expect(db.alerts).toHaveLength(1);
    expect(db.accounts).toHaveLength(2);
    expect((await first.json()).alert_created).toBe(true);
    expect((await second.json()).alert_created).toBe(false);
  });

  it("keeps a failed alert write retryable, and the retry completes without duplicates", async () => {
    db.failAlertInsert = true;
    const failed = await deliver(0);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("upstash-nonretryable-error")).toBeNull();
    expect(db.alerts).toHaveLength(0);

    db.failAlertInsert = false;
    const retried = await deliver(1);
    expect(retried.status).toBe(200);
    expect(db.transactions).toHaveLength(1);
    expect(db.alerts).toHaveLength(1);
  });

  it("keeps a model outage retryable and writes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const res = await deliver(0);
    expect(res.status).toBe(503);
    expect(res.headers.get("upstash-nonretryable-error")).toBeNull();
    expect(db.transactions).toHaveLength(0);
  });

  it("sends an invalid transaction to the DLQ (489) without writing", async () => {
    const res = await POST(
      new Request("https://mulewatch.test/api/qstash/transactions", {
        method: "POST",
        headers: { "upstash-signature": "sig", "upstash-message-id": "msg_bad" },
        body: JSON.stringify({ ...JSON.parse(EVENT), type: "BITCOIN" }),
      }),
    );
    expect(res.status).toBe(489);
    expect(res.headers.get("upstash-nonretryable-error")).toBe("true");
    expect(db.transactions).toHaveLength(0);
  });
});
