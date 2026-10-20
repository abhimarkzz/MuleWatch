import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AlertTransactionRow = {
  id: string;
  external_transaction_id: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | string | null;
  model_version: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate the request using the Supabase access token.
    const authorization = request.headers.get("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
      return NextResponse.json(
        { error: "Authentication required. Please sign in." },
        { status: 401 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error(
        "Supabase authentication environment variables are missing."
      );

      return NextResponse.json(
        { error: "Authentication service is not configured." },
        { status: 500 }
      );
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });

    const {
      data: authData,
      error: authError,
    } = await supabaseAuth.auth.getUser(token);

    if (authError || !authData.user) {
      return NextResponse.json(
        {
          error:
            "Your session is invalid or expired. Please sign in again.",
        },
        { status: 401 }
      );
    }

    // 2. Retrieve unresolved alerts, newest first.
    const { data: alerts, error: alertsError } =
      await supabaseAdmin
        .from("alerts")
        .select(
          "id, transaction_id, severity, status, risk_score, reason, created_at"
        )
        .neq("status", "resolved")
        .order("created_at", { ascending: false })
        .limit(100);

    if (alertsError) {
      console.error("Alert query failed:", alertsError.message);

      return NextResponse.json(
        { error: "Could not load alerts from the database." },
        { status: 500 }
      );
    }

    if (!alerts || alerts.length === 0) {
      return NextResponse.json(
        { alerts: [] },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // 3. Collect unique transaction IDs associated with alerts.
    const transactionIds = [
      ...new Set(
        alerts
          .map((alert) => alert.transaction_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    if (transactionIds.length === 0) {
      return NextResponse.json(
        { alerts: [] },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // 4. Retrieve the associated transaction records.
    const { data: transactions, error: transactionsError } =
      await supabaseAdmin
        .from("transactions")
        .select(
          [
            "id",
            "external_transaction_id",
            "transaction_type",
            "amount",
            "transaction_step",
            "predicted_is_fraud",
            "model_score",
            "model_version",
            "metadata",
            "created_at",
          ].join(", ")
        )
        .in("id", transactionIds);

    if (transactionsError) {
      console.error(
        "Transaction query failed:",
        transactionsError.message
      );

      return NextResponse.json(
        {
          error: "Could not load the associated transactions.",
        },
        { status: 500 }
      );
    }

    // 5. Type the transaction records explicitly.
    // The cast handles Supabase-generated JSON/database types.
    const transactionRows = (
      transactions ?? []
    ) as unknown as AlertTransactionRow[];

    // 6. Index transactions by their database IDs.
    const transactionMap = new Map<string, AlertTransactionRow>(
      transactionRows.map(
        (transaction) =>
          [transaction.id, transaction] as const
      )
    );

    // 7. Classify alerts without confusing demonstrations
    // with predictions produced by the fraud model.
    const queue = alerts.flatMap((alert) => {
      const transaction =
        transactionMap.get(alert.transaction_id) ?? null;

      // A genuine model-generated alert must have a positive
      // prediction recorded on its associated transaction.
      const isModelPrediction =
        transaction?.predicted_is_fraud === true;

      const metadata = transaction?.metadata;

      // PaySim demonstration alerts are accepted only when both
      // the dataset label and the alert reason identify the demo.
      const isPaySimDemo =
        metadata?.dataset === "PaySim" &&
        String(metadata?.ground_truth_is_fraud ?? "") === "1" &&
        typeof alert.reason === "string" &&
        alert.reason.startsWith(
          "Demonstration alert from PaySim ground-truth label"
        );

      // Ignore alerts that cannot be verified as either source.
      if (!isModelPrediction && !isPaySimDemo) {
        return [];
      }

      return [
        {
          ...alert,
          transaction,
          alert_source: isModelPrediction
            ? ("model_prediction" as const)
            : ("ground_truth_demo" as const),
        },
      ];
    });

    // 8. Return uncached results to the authenticated client.
    return NextResponse.json(
      { alerts: queue },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Unexpected alert API error:", error);

    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while loading alerts.",
      },
      { status: 500 }
    );
  }
}