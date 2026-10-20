import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  connection: vi.fn(),
  dbResult: { data: [] as unknown, error: null as unknown },
  rpcResult: { data: [] as unknown, error: null as unknown },
  tableResults: {} as Record<
    string,
    { data: unknown; error: unknown; count?: number | null }
  >,
  queries: [] as Array<Record<string, unknown> & { calls: Array<[string, unknown[]]> }>,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    connection: mocks.connection,
  };
});

// Routes verify tokens with getClaims. Tests describe the signed-in user via
// mocks.getUser; this adapter turns that into the claims getClaims returns.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      getClaims: async (token: string) => {
        const { data, error } = await mocks.getUser(token);
        if (error) return { data: null, error };
        const user = data?.user;
        return {
          data: user
            ? { claims: { sub: user.id, email: user.email, role: user.role ?? "authenticated" } }
            : null,
          error: null,
        };
      },
    },
  })),
}));

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({
    from: mocks.from,
    rpc: mocks.rpc,
  }),
}));

import { NextRequest } from "next/server";
import { POST as predictPost } from "./predict/route";
import { GET as alertsGet } from "./alerts/route";
import { PATCH as alertPatch } from "./alerts/[id]/route";
import { GET as networkGet } from "./network/route";
import { GET as accountHistoryGet } from "./network/accounts/[id]/transactions/route";

const TEST_API_KEY = "unit-test-api-key";
const TEST_ALERT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const TEST_TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";
const TEST_EXTERNAL_TRANSACTION_ID = "day24-test-transaction";

const VALID_TRANSACTION = {
  external_transaction_id: TEST_EXTERNAL_TRANSACTION_ID,
  source_account_external_id: "C100100",
  destination_account_external_id: "M200200",
  step: 100,
  type: "TRANSFER",
  amount: 5000,
  oldbalanceOrg: 10000,
  oldbalanceDest: 2000,
  orig_txn_count_before: 1,
  dest_txn_count_before: 4,
  dest_is_merchant: 0,
};

// Mirrors the PostgREST builder: every method chains and the builder can be
// awaited at any point. Calls are recorded for assertions.
function makeQuery(
  result: { data: unknown; error: unknown; count?: number | null } = mocks.dbResult,
) {
  const query: Record<string, unknown> & { calls: Array<[string, unknown[]]> } = { calls: [] };

  for (const method of [
    "select", "neq", "order", "update", "eq", "or", "upsert", "ilike",
    "like", "limit", "in", "range", "maybeSingle", "single", "insert",
  ]) {
    query[method] = vi.fn((...args: unknown[]) => {
      query.calls.push([method, args]);
      return query;
    });
  }

  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ count: null, ...result }).then(resolve, reject);

  mocks.queries.push(query);
  return query;
}

type NextRequestInit = NonNullable<
  ConstructorParameters<typeof NextRequest>[1]
>;

function nextRequest(url: string, init?: NextRequestInit) {
  return new NextRequest(url, init);
}

function silenceExpectedConsoleError(expectedMessage: string) {
  const originalError = console.error.bind(console);

  return vi.spyOn(console, "error").mockImplementation((...args) => {
    const message = args[0];

    // Silence only the intentional error from this failure-path test.
    // Any unrelated console.error remains visible in the test output.
    if (typeof message === "string" && message.includes(expectedMessage)) {
      return;
    }

    originalError(...args);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function authorizedHeaders() {
  return { authorization: "Bearer unit-test-token" };
}

function jsonRequest(
  url: string,
  body: unknown,
  method = "POST",
) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": TEST_API_KEY,
    },
    body: JSON.stringify(body),
  });
}

function patchAlertRequest(body: string) {
  return alertPatch(
    nextRequest(`http://localhost/api/alerts/${TEST_ALERT_ID}`, {
      method: "PATCH",
      headers: {
        ...authorizedHeaders(),
        "content-type": "application/json",
      },
      body,
    }),
    { params: Promise.resolve({ id: TEST_ALERT_ID }) },
  );
}

function accountHistoryRequest(
  url: string,
  accountId = TEST_ACCOUNT_ID,
) {
  return accountHistoryGet(
    nextRequest(url, { headers: authorizedHeaders() }),
    { params: Promise.resolve({ id: accountId }) },
  );
}

function makeAlert(
  id: string,
  transaction_id: string | null,
  reason: string,
) {
  return {
    id,
    transaction_id,
    severity: "high",
    status: "open",
    risk_score: 0.9,
    reason,
    created_at: "2026-10-20T10:00:00.000Z",
  };
}

function makeTransaction(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    external_transaction_id: `external-${id}`,
    transaction_type: "TRANSFER",
    amount: "500",
    transaction_step: 100,
    predicted_is_fraud: false,
    model_score: "0.1",
    model_version: "rf-test",
    metadata: null,
    created_at: "2026-10-20T10:00:00.000Z",
    ...overrides,
  };
}

function mockModelResponse(
  payload: unknown,
  status = 200,
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function configureSuccessfulDatabaseSave() {
  mocks.tableResults.accounts = {
    data: { id: "test-account-id" },
    error: null,
  };

  mocks.tableResults.transactions = {
    data: {
      id: TEST_TRANSACTION_ID,
      external_transaction_id: TEST_EXTERNAL_TRANSACTION_ID,
      created_at: "2026-10-20T10:00:00.000Z",
    },
    error: null,
  };

  mocks.tableResults.alerts = {
    data: [],
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  process.env.MULEWATCH_API_KEY = TEST_API_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL =
    "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "test-only-publishable-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    "test-only-service-role-key";

  mocks.connection.mockResolvedValue(undefined);

  mocks.getUser.mockResolvedValue({
    data: { user: { id: "test-user" } },
    error: null,
  });

  mocks.dbResult = { data: [], error: null };
  mocks.rpcResult = { data: [], error: null };
  mocks.tableResults = {};
  mocks.queries = [];

  mocks.from.mockImplementation((table: string) =>
    makeQuery(
      mocks.tableResults[table] ?? mocks.dbResult,
    ),
  );

  mocks.rpc.mockImplementation(async () => mocks.rpcResult);
});

describe("POST /api/predict", () => {
  it("rejects requests without credentials", async () => {
    const response = await predictPost(
      new Request("http://localhost/api/predict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects malformed JSON", async () => {
    const response = await predictPost(
      new Request("http://localhost/api/predict", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": TEST_API_KEY,
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Request body must be valid JSON.",
    });
  });

  it("rejects an invalid transaction type", async () => {
    const response = await predictPost(
      jsonRequest(
        "http://localhost/api/predict",
        { type: "NOT_A_TRANSACTION" },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid transaction type.",
    });
  });

  it("rejects a negative transaction amount", async () => {
    const response = await predictPost(
      jsonRequest("http://localhost/api/predict", {
        ...VALID_TRANSACTION,
        amount: -1,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 503 when prediction authentication is not configured", async () => {
    delete process.env.MULEWATCH_API_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    const response = await predictPost(
      new Request("http://localhost/api/predict", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
  });

  it("rejects a JSON primitive instead of an object", async () => {
    const response = await predictPost(
      jsonRequest("http://localhost/api/predict", "not-an-object"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Request body must be a JSON object.",
    });
  });

  it("rejects missing numeric fields", async () => {
    const response = await predictPost(
      jsonRequest("http://localhost/api/predict", {
        type: "TRANSFER",
        step: 100,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "All numeric fields must contain valid numbers.",
    });
  });

  it.each([
    ["negative step", { step: -1 }],
    ["fractional step", { step: 1.5 }],
    ["negative sender count", { orig_txn_count_before: -1 }],
    ["fractional receiver count", { dest_txn_count_before: 1.5 }],
    ["invalid merchant flag", { dest_is_merchant: 2 }],
    ["empty external transaction ID", {
      external_transaction_id: "",
    }],
  ])("rejects invalid transaction fields: %s", async (_label, overrides) => {
    const response = await predictPost(
      jsonRequest("http://localhost/api/predict", {
        ...VALID_TRANSACTION,
        ...overrides,
      }),
    );

    expect(response.status).toBe(400);
  });
});

describe("Prediction inference and persistence", () => {
  const url = "http://localhost/api/predict";

  function postValidPrediction() {
    return predictPost(jsonRequest(url, VALID_TRANSACTION));
  }

  it("saves a legitimate prediction without creating an alert", async () => {
    configureSuccessfulDatabaseSave();

    const fetchSpy = mockModelResponse({
      predicted_is_fraud: false,
      fraud_probability: 0.1,
      model_version: "rf-unit-test",
    });

    const response = await postValidPrediction();

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      transaction_id: TEST_TRANSACTION_ID,
      external_transaction_id: TEST_EXTERNAL_TRANSACTION_ID,
      predicted_is_fraud: false,
      fraud_probability: 0.1,
      model_version: "rf-unit-test",
      saved_to_supabase: true,
      alert_created: false,
    });

    expect(mocks.from).toHaveBeenCalledWith("accounts");
    expect(mocks.from).toHaveBeenCalledWith("transactions");
    expect(mocks.from).not.toHaveBeenCalledWith("alerts");

    const sentBody = JSON.parse(
      String(fetchSpy.mock.calls[0]?.[1]?.body),
    );

    expect(sentBody).toEqual({
      step: 100,
      type: "TRANSFER",
      amount: 5000,
      oldbalanceOrg: 10000,
      oldbalanceDest: 2000,
      orig_txn_count_before: 1,
      dest_txn_count_before: 4,
      dest_is_merchant: 0,
    });

    expect(sentBody).not.toHaveProperty(
      "source_account_external_id",
    );
    expect(sentBody).not.toHaveProperty(
      "destination_account_external_id",
    );
  });

  it("creates an alert when the model flags fraud", async () => {
    configureSuccessfulDatabaseSave();

    mockModelResponse({
      predicted_is_fraud: true,
      fraud_probability: 0.96,
      model_version: "rf-unit-test",
    });

    const response = await postValidPrediction();

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      predicted_is_fraud: true,
      fraud_probability: 0.96,
      alert_created: true,
      saved_to_supabase: true,
    });

    expect(mocks.from).toHaveBeenCalledWith("alerts");
  });

  it("does not duplicate an existing model alert", async () => {
    configureSuccessfulDatabaseSave();

    mocks.tableResults.alerts = {
      data: [{ id: "existing-alert-id" }],
      error: null,
    };

    mockModelResponse({
      predicted_is_fraud: true,
      fraud_probability: 0.96,
      model_version: "rf-unit-test",
    });

    const response = await postValidPrediction();

    expect(response.status).toBe(200);
    expect((await response.json()).alert_created).toBe(false);
  });

  
  it("returns 503 when the upstream model service fails", async () => {
    silenceExpectedConsoleError("Render prediction failed");

    const fetchSpy = mockModelResponse(
      { error: "Model unavailable" },
      503,
    );

    const response = await postValidPrediction();

    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toEqual(expect.any(String));
    expect(body.error.length).toBeGreaterThan(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });


  it("returns 502 when the model response contains an invalid probability", async () => {
    mockModelResponse({
      predicted_is_fraud: true,
      fraud_probability: 1.5,
      model_version: "rf-unit-test",
    });

    const response = await postValidPrediction();

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "The prediction service returned an invalid response.",
    });

    expect(mocks.from).not.toHaveBeenCalled();
  });

  
  it("returns 502 when saving the transaction fails", async () => {
    silenceExpectedConsoleError("Prediction route failed");

    mocks.tableResults.accounts = {
      data: { id: "test-account-id" },
      error: null,
    };

    mocks.tableResults.transactions = {
      data: null,
      error: { message: "Transaction save failed" },
    };

    mockModelResponse({
      predicted_is_fraud: false,
      fraud_probability: 0.1,
      model_version: "rf-unit-test",
    });

    const response = await postValidPrediction();

    expect(response.status).toBe(502);

    expect(await response.json()).toMatchObject({
      error:
        "The prediction or database save failed. Please retry shortly. If the problem continues, check the server logs.",
    });
  });


  
  it("returns 503 when the model request throws", async () => {
    silenceExpectedConsoleError("Render prediction service is unreachable");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Simulated network failure"),
    );

    const response = await postValidPrediction();

    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toEqual(expect.any(String));
    expect(body.error.length).toBeGreaterThan(0);

    expect(mocks.from).not.toHaveBeenCalled();
  });

});

describe("GET /api/alerts", () => {
  const url = "http://localhost/api/alerts";

  function authenticatedRequest(query = "") {
    return nextRequest(`${url}${query}`, { headers: authorizedHeaders() });
  }

  function alertQueryCalls() {
    // The first query on "alerts" is the paged list; later ones are counts.
    const index = mocks.from.mock.calls.findIndex(([table]) => table === "alerts");
    return mocks.queries[index].calls;
  }

  const MODEL_REASON = "Random Forest flagged this transaction for review.";
  const DEMO_REASON = "Demonstration alert from PaySim ground-truth label isFraud=1";

  it("rejects a request without a bearer token", async () => {
    const response = await alertsGet(nextRequest(url));

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid Supabase session", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid token" },
    });

    const response = await alertsGet(authenticatedRequest());

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns an empty first page with totals", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    const response = await alertsGet(authenticatedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alerts: [],
      page: 1,
      pageSize: 25,
      total: 0,
      pageCount: 1,
      summary: { open: 0, investigating: 0 },
    });
  });

  it("returns 500 when the alert query fails", async () => {
    silenceExpectedConsoleError("Alert query failed");
    mocks.tableResults.alerts = { data: null, error: { message: "Database unavailable" } };

    const response = await alertsGet(authenticatedRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Could not load alerts from the database.",
    });
  });

  it("keeps verified model and PaySim alerts and counts the rest as unverified", async () => {
    mocks.tableResults.alerts = {
      data: [
        { ...makeAlert("alert-model", "tx-model", MODEL_REASON), transaction: makeTransaction("tx-model", { predicted_is_fraud: true, model_score: "0.98" }) },
        {
          ...makeAlert("alert-demo", "tx-demo", DEMO_REASON),
          transaction: makeTransaction("tx-demo", { metadata: { dataset: "PaySim", ground_truth_is_fraud: "1" } }),
        },
        { ...makeAlert("alert-unverified", "tx-normal", MODEL_REASON), transaction: makeTransaction("tx-normal") },
        { ...makeAlert("alert-orphan", "tx-missing", DEMO_REASON), transaction: null },
      ],
      error: null,
      count: 4,
    };

    const body = await (await alertsGet(authenticatedRequest())).json();

    expect(body.alerts.map((item: { id: string }) => item.id)).toEqual(["alert-model", "alert-demo"]);
    expect(body.alerts.map((item: { alert_source: string }) => item.alert_source)).toEqual([
      "model_prediction",
      "ground_truth_demo",
    ]);
    expect(body.unverified).toBe(2);
    // The transaction comes from the embed; no second query is made.
    expect(mocks.from).not.toHaveBeenCalledWith("transactions");
  });

  it("applies filters, sort and the requested page in the database query", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 60 };

    const body = await (
      await alertsGet(authenticatedRequest("?status=open&severity=high&source=model_prediction&sort=oldest&page=3"))
    ).json();

    const calls = alertQueryCalls();
    expect(calls).toContainEqual(["select", [expect.any(String), { count: "exact" }]]);
    expect(calls).toContainEqual(["neq", ["status", "resolved"]]);
    expect(calls).toContainEqual(["eq", ["status", "open"]]);
    expect(calls).toContainEqual(["eq", ["severity", "high"]]);
    expect(calls).toContainEqual(["or", [`reason.eq."${MODEL_REASON}"`]]);
    expect(calls).toContainEqual(["order", ["created_at", { ascending: true }]]);
    expect(calls).toContainEqual(["range", [50, 74]]);
    expect(body).toMatchObject({ page: 3, total: 60, pageCount: 3 });
  });

  it("sorts by risk with unscored alerts last by default", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    await alertsGet(authenticatedRequest());

    expect(alertQueryCalls()).toContainEqual(["order", ["risk_score", { ascending: false, nullsFirst: false }]]);
  });

  it("ignores invalid filter values", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    await alertsGet(authenticatedRequest("?status=resolved&severity=extreme&page=-2"));

    const calls = alertQueryCalls();
    expect(calls.filter(([method]) => method === "eq")).toEqual([]);
    expect(calls).toContainEqual(["range", [0, 24]]);
  });

  it("searches transaction references literally through an inner join", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    await alertsGet(authenticatedRequest("?q=50%25_off"));

    const calls = alertQueryCalls();
    expect(calls[0][1][0]).toContain("transaction:transactions!inner(");
    expect(calls).toContainEqual(["ilike", ["transaction.external_transaction_id", "%50\\%\\_off%"]]);
  });

  it("skips the summary counts when the client already has them", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    const body = await (await alertsGet(authenticatedRequest("?page=2&summary=0"))).json();

    expect(mocks.from.mock.calls.filter(([table]) => table === "alerts")).toHaveLength(1);
    expect(body.summary).toBeUndefined();
  });

  it("escapes PostgREST's * wildcard alias in searches", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    await alertsGet(authenticatedRequest("?q=a*b"));

    expect(alertQueryCalls()).toContainEqual(["ilike", ["transaction.external_transaction_id", "%a\\*b%"]]);
  });

  it("uses a left join when not searching", async () => {
    mocks.tableResults.alerts = { data: [], error: null, count: 0 };

    await alertsGet(authenticatedRequest());

    expect(alertQueryCalls()[0][1][0]).toContain("transaction:transactions(");
  });

  it("resolves a UUID search to the alert's transaction", async () => {
    const alertId = "44444444-4444-4444-8444-444444444444";
    let call = 0;
    mocks.from.mockImplementation(() => {
      call += 1;
      return call === 1
        ? makeQuery({ data: [{ transaction_id: "tx-of-alert" }], error: null })
        : makeQuery({ data: [], error: null, count: 0 });
    });

    await alertsGet(authenticatedRequest(`?q=${alertId}`));

    expect(mocks.queries[1].calls).toContainEqual(["in", ["transaction_id", [alertId, "tx-of-alert"]]]);
  });

  it("serves the last page when the requested page is past the end", async () => {
    let call = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table !== "alerts") return makeQuery(mocks.dbResult);
      call += 1;
      // 1: page 9 (out of range), 2-3: summary counts, 4: total, 5: last page
      if (call === 1) return makeQuery({ data: null, error: { code: "PGRST103", message: "range" } });
      if (call === 4) return makeQuery({ data: null, error: null, count: 30 });
      return makeQuery({ data: [], error: null, count: 30 });
    });

    const body = await (await alertsGet(authenticatedRequest("?page=9"))).json();

    expect(body).toMatchObject({ page: 2, pageCount: 2, total: 30 });
  });
});

describe("PATCH /api/alerts/[id]", () => {
  it("rejects a request without a bearer token", async () => {
    const response = await alertPatch(
      nextRequest(`http://localhost/api/alerts/${TEST_ALERT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "investigating" }),
      }),
      { params: Promise.resolve({ id: TEST_ALERT_ID }) },
    );

    expect(response.status).toBe(401);
  });

  it("rejects an invalid alert ID", async () => {
    const response = await alertPatch(
      nextRequest("http://localhost/api/alerts/not-a-uuid", {
        method: "PATCH",
        headers: {
          ...authorizedHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "investigating" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an unsupported alert status", async () => {
    const response = await patchAlertRequest(
      JSON.stringify({ status: "deleted" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns the database-confirmed update", async () => {
    mocks.tableResults.alerts = {
      data: { id: TEST_ALERT_ID, status: "investigating" },
      error: null,
    };

    const response = await patchAlertRequest(
      JSON.stringify({ status: "investigating" }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).alert).toEqual({
      id: TEST_ALERT_ID,
      status: "investigating",
    });
    expect(mocks.from).toHaveBeenCalledWith("alerts");
  });

  it("rejects malformed JSON", async () => {
    const response = await patchAlertRequest("{");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Request body must contain valid JSON.",
    });
  });

  it("rejects a body without status", async () => {
    const response = await patchAlertRequest(
      JSON.stringify({ note: "Investigate" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "A valid status is required.",
    });
  });

  it("returns 500 when the status update fails", async () => {
    silenceExpectedConsoleError("Alert status update failed");
    mocks.tableResults.alerts = {
      data: null,
      error: { message: "Constraint violation" },
    };

    const response = await patchAlertRequest(
      JSON.stringify({ status: "investigating" }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error:
        "Could not update the alert. Check the database status constraints.",
    });
  });

  it("returns 404 when the alert does not exist", async () => {
    mocks.tableResults.alerts = {
      data: null,
      error: null,
    };

    const response = await patchAlertRequest(
      JSON.stringify({ status: "resolved" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Alert not found.",
    });
  });
});

describe("GET /api/network", () => {
  const url = "http://localhost/api/network";

  function authenticatedRequest() {
    return nextRequest(url, {
      headers: authorizedHeaders(),
    });
  }

  it("rejects requests without a bearer token", async () => {
    const response = await networkGet(nextRequest(url));

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("queries the two-hop transaction function", async () => {
    const response = await networkGet(authenticatedRequest());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "get_mulewatch_two_hop_transactions",
      { edge_limit: 100 },
    );
  });

  it("rejects an invalid Supabase session", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Expired token" },
    });

    const response = await networkGet(authenticatedRequest());

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns 500 when the RPC call fails", async () => {
    silenceExpectedConsoleError("MuleWatch network RPC failed");
    mocks.rpcResult = {
      data: null,
      error: { message: "RPC unavailable" },
    };

    const response = await networkGet(authenticatedRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Could not load the transaction network.",
    });
  });

  it("builds nodes and links for a connected two-hop path", async () => {
    mocks.rpcResult = {
      error: null,
      data: [
        {
          transaction_id: "tx-1",
          source_account_id: "account-A",
          destination_account_id: "account-B",
          amount: "100.50",
          transaction_type: "TRANSFER",
          transaction_step: 1,
          predicted_is_fraud: true,
          model_score: "0.95",
          metadata: null,
          hop: 1,
        },
        {
          transaction_id: "tx-2",
          source_account_id: "account-B",
          destination_account_id: "account-C",
          amount: "invalid-number",
          transaction_type: "CASH_OUT",
          transaction_step: 2,
          predicted_is_fraud: false,
          model_score: null,
          metadata: null,
          hop: 2,
        },
        {
          transaction_id: "tx-invalid",
          source_account_id: "",
          destination_account_id: "account-D",
          amount: "200",
          transaction_type: "TRANSFER",
          transaction_step: 3,
          predicted_is_fraud: false,
          model_score: null,
          metadata: null,
          hop: 1,
        },
      ],
    };

    const response = await networkGet(authenticatedRequest());

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.nodes).toHaveLength(3);
    expect(body.links).toHaveLength(2);
    expect(body.links[0].amount).toBe(100.5);
    expect(body.links[1].amount).toBe(0);
    expect(body.twoHopPaths).toHaveLength(1);
  });
});

describe("GET /api/network/accounts/[id]/transactions", () => {
  it("rejects an invalid account UUID", async () => {
    const response = await accountHistoryGet(
      nextRequest(
        "http://localhost/api/network/accounts/invalid/transactions",
      ),
      { params: Promise.resolve({ id: "invalid" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns empty history and pagination statistics", async () => {
    const response = await accountHistoryRequest(
      `http://localhost/api/network/accounts/${TEST_ACCOUNT_ID}/transactions`,
    );

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      transactions: [],
      stats: {
        returned: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
    });

    expect(mocks.from).toHaveBeenCalledWith("transactions");
  });

  it("rejects a missing bearer token", async () => {
    const response = await accountHistoryGet(
      nextRequest(
        `http://localhost/api/network/accounts/${TEST_ACCOUNT_ID}/transactions`,
      ),
      { params: Promise.resolve({ id: TEST_ACCOUNT_ID }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid session", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Session expired" },
    });

    const response = await accountHistoryRequest(
      `http://localhost/api/network/accounts/${TEST_ACCOUNT_ID}/transactions`,
    );

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 500 when the transaction history query fails", async () => {
    silenceExpectedConsoleError("Account transaction history query failed");
    mocks.tableResults.transactions = {
      data: null,
      error: { message: "Database unavailable" },
    };

    const response = await accountHistoryRequest(
      `http://localhost/api/network/accounts/${TEST_ACCOUNT_ID}/transactions`,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Could not load this account's transaction history.",
    });
  });

  it("normalizes values and clamps pagination parameters", async () => {
    mocks.tableResults.transactions = {
      error: null,
      data: [
        {
          id: "tx-history-1",
          source_account_id: TEST_ACCOUNT_ID,
          destination_account_id: "33333333-3333-4333-8333-333333333333",
          transaction_type: "TRANSFER",
          amount: "123.45",
          transaction_step: 10,
          predicted_is_fraud: false,
          model_score: "not-a-number",
          metadata: null,
        },
      ],
    };

    const response = await accountHistoryRequest(
      `http://localhost/api/network/accounts/${TEST_ACCOUNT_ID}/transactions?limit=250&offset=20000`,
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.transactions[0].amount).toBe(123.45);
    expect(body.transactions[0].model_score).toBeNull();
    expect(body.stats).toEqual({
      returned: 1,
      limit: 100,
      offset: 10000,
      hasMore: false,
    });
  });
});

describe("Shared route authorisation", () => {
  afterEach(() => {
    delete process.env.MULEWATCH_ANALYST_EMAILS;
  });

  it("returns 403 for a valid user outside the analyst allowlist", async () => {
    process.env.MULEWATCH_ANALYST_EMAILS = "analyst@example.com";
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "u", email: "someone@example.com" } },
      error: null,
    });

    const response = await alertsGet(
      nextRequest("http://localhost/api/alerts", { headers: authorizedHeaders() }),
    );

    expect(response.status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("admits an allowlisted analyst", async () => {
    process.env.MULEWATCH_ANALYST_EMAILS = "Analyst@Example.com";
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "u", email: "analyst@example.com" } },
      error: null,
    });

    const response = await networkGet(
      nextRequest("http://localhost/api/network", { headers: authorizedHeaders() }),
    );

    expect(response.status).toBe(200);
  });

  it("returns 503 when the auth service throws", async () => {
    const spy = silenceExpectedConsoleError("Supabase token verification failed");
    mocks.getUser.mockRejectedValue(new Error("network down"));

    const response = await alertsGet(
      nextRequest("http://localhost/api/alerts", { headers: authorizedHeaders() }),
    );

    expect(response.status).toBe(503);
    spy.mockRestore();
  });

  it("rejects a verified token that is not a signed-in user", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "service", role: "service_role" } },
      error: null,
    });

    const response = await alertsGet(
      nextRequest("http://localhost/api/alerts", { headers: authorizedHeaders() }),
    );

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 503, not 401, when Supabase auth is unreachable", async () => {
    const spy = silenceExpectedConsoleError("Supabase auth is unavailable");
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
    });

    const response = await networkGet(
      nextRequest("http://localhost/api/network", { headers: authorizedHeaders() }),
    );

    expect(response.status).toBe(503);
    spy.mockRestore();
  });

  it("treats a duplicate-key alert insert as an existing alert", async () => {
    configureSuccessfulDatabaseSave();
    let alertsCall = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table !== "alerts") return makeQuery(mocks.tableResults[table] ?? mocks.dbResult);
      alertsCall += 1;
      // 1: lookup finds nothing, 2: insert loses the race to a concurrent request
      return makeQuery(alertsCall === 1 ? { data: [], error: null } : { data: null, error: { code: "23505", message: "duplicate key" } });
    });
    mockModelResponse({ predicted_is_fraud: true, fraud_probability: 0.95, model_version: "rf" });

    const response = await predictPost(jsonRequest("http://localhost/api/predict", VALID_TRANSACTION));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ predicted_is_fraud: true, alert_created: false });
  });

  it("passes the model decision threshold through to the client", async () => {
    configureSuccessfulDatabaseSave();
    mockModelResponse({
      predicted_is_fraud: false,
      fraud_probability: 0.2,
      decision_threshold: 0.405418,
      model_version: "rf-unit-test",
    });

    const response = await predictPost(
      jsonRequest("http://localhost/api/predict", VALID_TRANSACTION),
    );

    expect(await response.json()).toMatchObject({ decision_threshold: 0.405418 });
  });
});
