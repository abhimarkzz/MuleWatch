import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 120;

const RENDER_API_URL = (
  process.env.RENDER_API_URL ?? "https://mulewatch.onrender.com"
).replace(/\/+$/, "");

const TRANSACTION_TYPES = [
  "PAYMENT",
  "TRANSFER",
  "CASH_OUT",
  "CASH_IN",
  "DEBIT",
] as const;

type TransactionType = (typeof TRANSACTION_TYPES)[number];

type IncomingTransaction = {
  step: number;
  type: TransactionType;
  amount: number;
  oldbalanceOrg: number;
  oldbalanceDest: number;
  orig_txn_count_before: number;
  dest_txn_count_before: number;
  dest_is_merchant: number;
  external_transaction_id?: string;
  source_account_external_id?: string;
  destination_account_external_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function validOptionalId(
  value: unknown,
  maxLength: number
): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength)
  );
}

/**
 * Allows either:
 * 1. Server-to-server requests authenticated using x-api-key.
 * 2. Signed-in dashboard users authenticated using a Supabase access token.
 *
 * Never expose MULEWATCH_API_KEY in browser-side code.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  const expectedKey = process.env.MULEWATCH_API_KEY;
  const suppliedKey = request.headers.get("x-api-key") ?? "";

  // Preserve existing cURL and server-to-server authentication.
  if (expectedKey && suppliedKey) {
    const supplied = Buffer.from(suppliedKey);
    const expected = Buffer.from(expectedKey);

    if (
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    ) {
      return true;
    }
  }

  // Allow users authenticated through Supabase to use the dashboard.
  const authorization = request.headers.get("authorization");
  const token = authorization
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publicKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!token || !supabaseUrl || !publicKey) {
    return false;
  }

  try {
    const authClient = createClient(supabaseUrl, publicKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error,
    } = await authClient.auth.getUser(token);

    return !error && Boolean(user);
  } catch (error) {
    console.error("Supabase token verification failed:", error);
    return false;
  }
}

export async function POST(request: Request) {
  // 1. Authenticate the request.
  const authorized = await isAuthorized(request);

  if (!authorized) {
    const hasCredentials =
      Boolean(request.headers.get("x-api-key")) ||
      request.headers.has("authorization");

    if (
      !process.env.MULEWATCH_API_KEY &&
      !process.env.NEXT_PUBLIC_SUPABASE_URL &&
      !hasCredentials
    ) {
      return NextResponse.json(
        { error: "Prediction API authentication is not configured." },
        {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    return NextResponse.json(
      { error: "Unauthorized. Please sign in and retry." },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  // 2. Parse the request body.
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (!isRecord(rawBody)) {
    return NextResponse.json(
      { error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  // 3. Validate transaction type.
  const type = rawBody.type;

  if (
    typeof type !== "string" ||
    !TRANSACTION_TYPES.includes(type as TransactionType)
  ) {
    return NextResponse.json(
      { error: "Invalid transaction type." },
      { status: 400 }
    );
  }

  // 4. Validate numeric fields.
  const numericFields = [
    "step",
    "amount",
    "oldbalanceOrg",
    "oldbalanceDest",
    "orig_txn_count_before",
    "dest_txn_count_before",
    "dest_is_merchant",
  ];

  if (
    numericFields.some(
      (field) =>
        typeof rawBody[field] !== "number" ||
        !Number.isFinite(rawBody[field])
    )
  ) {
    return NextResponse.json(
      { error: "All numeric fields must contain valid numbers." },
      { status: 400 }
    );
  }

  if (
    !isNonNegativeInteger(rawBody.step) ||
    !isNonNegativeNumber(rawBody.amount) ||
    !isNonNegativeNumber(rawBody.oldbalanceOrg) ||
    !isNonNegativeNumber(rawBody.oldbalanceDest) ||
    !isNonNegativeInteger(rawBody.orig_txn_count_before) ||
    !isNonNegativeInteger(rawBody.dest_txn_count_before) ||
    (rawBody.dest_is_merchant !== 0 &&
      rawBody.dest_is_merchant !== 1) ||
    !validOptionalId(rawBody.external_transaction_id, 150) ||
    !validOptionalId(rawBody.source_account_external_id, 200) ||
    !validOptionalId(rawBody.destination_account_external_id, 200)
  ) {
    return NextResponse.json(
      { error: "One or more transaction fields are invalid." },
      { status: 400 }
    );
  }

  const transaction = rawBody as unknown as IncomingTransaction;

  try {
    // 5. Prepare only the features accepted by your existing
    // FastAPI PredictionRequest schema.
    const modelInput = {
      step: transaction.step,
      type: transaction.type,
      amount: transaction.amount,
      oldbalanceOrg: transaction.oldbalanceOrg,
      oldbalanceDest: transaction.oldbalanceDest,
      orig_txn_count_before: transaction.orig_txn_count_before,
      dest_txn_count_before: transaction.dest_txn_count_before,
      dest_is_merchant: transaction.dest_is_merchant,
    };

    // 6. Call Render with a separate timeout handler.
    let renderResponse: Response;

    try {
      renderResponse = await fetch(`${RENDER_API_URL}/predict`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(modelInput),
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      const errorName =
        error instanceof Error ? error.name : "";

      const timedOut =
        errorName === "TimeoutError" ||
        errorName === "AbortError";

      console.error(
        timedOut
          ? "Render prediction request timed out."
          : "Render prediction service is unreachable.",
        error
      );

      return NextResponse.json(
        {
          error: timedOut
            ? "The fraud prediction service did not respond within 90 seconds. It may still be waking up. Please retry shortly."
            : "The fraud prediction service is temporarily unreachable or waking from idle. Please wait and retry.",
          code: timedOut
            ? "RENDER_TIMEOUT"
            : "RENDER_UNAVAILABLE",
          retryable: true,
        },
        {
          status: timedOut ? 504 : 503,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    // 7. Handle unsuccessful responses from Render.
    if (!renderResponse.ok) {
      const temporarilyUnavailable = [502, 503, 504].includes(
        renderResponse.status
      );

      console.error(
        "Render prediction failed:",
        renderResponse.status
      );

      return NextResponse.json(
        {
          error: temporarilyUnavailable
            ? "The fraud prediction service is temporarily unavailable or still waking up. Please retry shortly."
            : "The fraud prediction service rejected the request.",
          code: temporarilyUnavailable
            ? "RENDER_UNAVAILABLE"
            : "RENDER_REQUEST_FAILED",
          retryable: temporarilyUnavailable,
        },
        {
          status: temporarilyUnavailable ? 503 : 502,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    // 8. Parse and validate the model response.
    let prediction: unknown;

    try {
      prediction = await renderResponse.json();
    } catch {
      return NextResponse.json(
        {
          error: "The prediction service returned invalid JSON.",
          code: "INVALID_MODEL_RESPONSE",
          retryable: false,
        },
        { status: 502 }
      );
    }

    if (
      !isRecord(prediction) ||
      typeof prediction.predicted_is_fraud !== "boolean" ||
      typeof prediction.fraud_probability !== "number" ||
      !Number.isFinite(prediction.fraud_probability) ||
      prediction.fraud_probability < 0 ||
      prediction.fraud_probability > 1
    ) {
      return NextResponse.json(
        {
          error: "The prediction service returned an invalid response.",
          code: "INVALID_MODEL_RESPONSE",
          retryable: false,
        },
        { status: 502 }
      );
    }

    const predictedIsFraud = prediction.predicted_is_fraud;
    const fraudProbability = prediction.fraud_probability;

    const modelVersion =
      typeof prediction.model_version === "string"
        ? prediction.model_version
        : "unknown";

    // 9. Resolve optional source and destination accounts.
    async function upsertAccount(
      externalId: string | undefined
    ): Promise<string | null> {
      if (!externalId) return null;

      const accountType = externalId.startsWith("M")
        ? "merchant"
        : externalId.startsWith("C")
          ? "customer"
          : "unknown";

      const { data, error } = await supabaseAdmin
        .from("accounts")
        .upsert(
          {
            external_account_id: externalId,
            account_type: accountType,
          },
          { onConflict: "external_account_id" }
        )
        .select("id")
        .single();

      if (error) throw error;

      return data.id;
    }

    const sourceAccountId = await upsertAccount(
      transaction.source_account_external_id
    );

    const destinationAccountId = await upsertAccount(
      transaction.destination_account_external_id
    );

    // Reuse the ID sent by the UI on retry to avoid duplicate
    // transaction rows when the caller retries the same request.
    const externalTransactionId =
      transaction.external_transaction_id ??
      `mulewatch-${crypto.randomUUID()}`;

    // 10. Save the transaction and its prediction in Supabase.
    const {
      data: savedTransaction,
      error: transactionError,
    } = await supabaseAdmin
      .from("transactions")
      .upsert(
        {
          external_transaction_id: externalTransactionId,
          source_account_id: sourceAccountId,
          destination_account_id: destinationAccountId,
          transaction_type: transaction.type,
          amount: transaction.amount,
          transaction_step: transaction.step,
          predicted_is_fraud: predictedIsFraud,
          model_score: fraudProbability,
          model_version: modelVersion,
          metadata: {
            source: "nextjs_api_route",
            model_features: modelInput,
          },
        },
        { onConflict: "external_transaction_id" }
      )
      .select("id, external_transaction_id, created_at")
      .single();

    if (transactionError) throw transactionError;

    // 11. Create an alert when the model flags a transaction.
    let alertCreated = false;

    if (predictedIsFraud) {
      const alertReason =
        "Random Forest flagged this transaction for review.";

      // Prevent ordinary retries from creating duplicate alerts.
      // A unique database constraint is needed to guarantee this
      // against simultaneous concurrent requests.
      const {
        data: existingAlerts,
        error: lookupError,
      } = await supabaseAdmin
        .from("alerts")
        .select("id")
        .eq("transaction_id", savedTransaction.id)
        .eq("reason", alertReason)
        .limit(1);

      if (lookupError) throw lookupError;

      if (!existingAlerts || existingAlerts.length === 0) {
        const severity =
          fraudProbability >= 0.9
            ? "critical"
            : fraudProbability >= 0.75
              ? "high"
              : "medium";

        const { error: alertError } = await supabaseAdmin
          .from("alerts")
          .insert({
            transaction_id: savedTransaction.id,
            severity,
            status: "open",
            risk_score: fraudProbability,
            reason: alertReason,
          });

        if (alertError) throw alertError;

        alertCreated = true;
      }
    }

    // 12. Return the prediction and persistence status.
    return NextResponse.json(
      {
        transaction_id: savedTransaction.id,
        external_transaction_id:
          savedTransaction.external_transaction_id,
        predicted_is_fraud: predictedIsFraud,
        fraud_probability: fraudProbability,
        model_version: modelVersion,
        saved_to_supabase: true,
        alert_created: alertCreated,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // Keep detailed errors in server logs, not in the public response.
    console.error("Prediction route failed:", error);

    return NextResponse.json(
      {
        error:
          "The prediction or database save failed. Please retry shortly. If the problem continues, check the server logs.",
        code: "PREDICTION_OR_DATABASE_ERROR",
        retryable: true,
      },
      {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}