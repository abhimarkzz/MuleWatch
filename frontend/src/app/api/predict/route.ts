import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const RENDER_API_URL = (
  process.env.RENDER_API_URL ??
  "https://mulewatch.onrender.com"
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength
    )
  );
}

export async function POST(request: Request) {
  // 1. Parse and validate incoming JSON.
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
    // 2. Call the existing Render FastAPI model.
    // Send only the eight features accepted by your current
    // PredictionRequest schema. Local metadata stays in Next.js.
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

    const renderResponse = await fetch(
      `${RENDER_API_URL}/predict`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelInput),
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      }
    );

    if (!renderResponse.ok) {
      console.error(
        "Render prediction failed:",
        renderResponse.status
      );

      return NextResponse.json(
        { error: "The fraud prediction service failed." },
        { status: 502 }
      );
    }

    const prediction: unknown = await renderResponse.json();

    if (
      !isRecord(prediction) ||
      typeof prediction.predicted_is_fraud !== "boolean" ||
      typeof prediction.fraud_probability !== "number" ||
      !Number.isFinite(prediction.fraud_probability) ||
      prediction.fraud_probability < 0 ||
      prediction.fraud_probability > 1
    ) {
      return NextResponse.json(
        { error: "The prediction service returned an invalid response." },
        { status: 502 }
      );
    }

    const predictedIsFraud = prediction.predicted_is_fraud;
    const fraudProbability = prediction.fraud_probability;
    const modelVersion =
      typeof prediction.model_version === "string"
        ? prediction.model_version
        : "unknown";

    // 3. Resolve optional account IDs in Supabase.
    async function upsertAccount(
      externalId: string | undefined
    ): Promise<string | null> {
      if (!externalId) return null;

      const accountType =
        externalId.startsWith("M")
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

    const externalTransactionId =
      transaction.external_transaction_id ??
      `mulewatch-${crypto.randomUUID()}`;

    // 4. Save the transaction and its model result.
    const { data: savedTransaction, error: transactionError } =
      await supabaseAdmin
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

    // 5. Create an alert if the model predicts fraud.
    let alertCreated = false;

    if (predictedIsFraud) {
      const alertReason =
        "Random Forest flagged this transaction for review.";

      // Avoid duplicate alerts for ordinary retries of the same
      // transaction. A database unique constraint would be needed
      // for a strict concurrency guarantee.
      const { data: existingAlerts, error: lookupError } =
        await supabaseAdmin
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

    // 6. Return the result to the caller.
    return NextResponse.json({
      transaction_id: savedTransaction.id,
      external_transaction_id:
        savedTransaction.external_transaction_id,
      predicted_is_fraud: predictedIsFraud,
      fraud_probability: fraudProbability,
      model_version: modelVersion,
      saved_to_supabase: true,
      alert_created: alertCreated,
    });
  } catch (error) {
    console.error("Prediction route failed:", error);

    return NextResponse.json(
      {
        error:
          "Prediction or database save failed. Check the server logs.",
      },
      { status: 502 }
    );
  }
}