
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase-admin";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TransactionHistoryRow = {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  transaction_type: string | null;
  amount: number | string | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | string | null;
  metadata: Record<string, unknown> | null;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: accountId } = await context.params;

    // Validate the account UUID before querying the database.
    if (!UUID_REGEX.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID." },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

    const publicKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !publicKey) {
      return NextResponse.json(
        { error: "Supabase environment variables are missing." },
        { status: 500 }
      );
    }

    // Require a valid signed-in Supabase user.
    const authorization = request.headers.get("authorization");

    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    if (!token) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    const authClient = createClient(supabaseUrl, publicKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json(
        { error: "Your session is invalid or expired." },
        { status: 401 }
      );
    }

    // Read and validate pagination parameters.
    const requestedLimit = Number(
      request.nextUrl.searchParams.get("limit") ?? 50
    );

    const requestedOffset = Number(
      request.nextUrl.searchParams.get("offset") ?? 0
    );

    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 100)
        : 50;

    const offset =
      Number.isFinite(requestedOffset) && requestedOffset >= 0
        ? Math.min(Math.floor(requestedOffset), 10000)
        : 0;

    // Fetch transactions where this account is the sender or recipient.
    const { data, error } = await supabaseAdmin
      .from("transactions")
      .select(
        [
          "id",
          "source_account_id",
          "destination_account_id",
          "transaction_type",
          "amount",
          "transaction_step",
          "predicted_is_fraud",
          "model_score",
          "metadata",
        ].join(", ")
      )
      .or(
        `source_account_id.eq.${accountId},destination_account_id.eq.${accountId}`
      )
      .order("transaction_step", {
        ascending: false,
        nullsFirst: false,
      })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error(
        "Account transaction history query failed:",
        error.message
      );

      return NextResponse.json(
        {
          error:
            "Could not load this account's transaction history.",
        },
        { status: 500 }
      );
    }

    // Supabase's inferred type for this query is not resolving correctly
    // in the current generated database types. Narrow the selected rows
    // explicitly before mapping them.
    const rows = (data ?? []) as unknown as TransactionHistoryRow[];

    const transactions = rows.map((transaction) => {
      const amount =
        transaction.amount === null
          ? null
          : Number(transaction.amount);

      const modelScore =
        transaction.model_score === null
          ? null
          : Number(transaction.model_score);

      return {
        ...transaction,
        amount:
          amount !== null && Number.isFinite(amount)
            ? amount
            : null,
        model_score:
          modelScore !== null && Number.isFinite(modelScore)
            ? modelScore
            : null,
      };
    });

    return NextResponse.json(
      {
        accountId,
        transactions,
        stats: {
          returned: transactions.length,
          limit,
          offset,
          hasMore: transactions.length === limit,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error("Account history API error:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    );
  }
}
