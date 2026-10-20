
import {
  NextRequest,
  NextResponse,
  connection,
} from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { authenticateRequest } from "@/lib/server/auth";

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
  await connection();
  try {
    const { id: accountId } = await context.params;

    // Validate the account UUID before querying the database.
    if (!UUID_REGEX.test(accountId)) {
      return NextResponse.json(
        { error: "Invalid account ID." },
        { status: 400 }
      );
    }

    const auth = await authenticateRequest(request);
    if (!auth.ok) return auth.response;

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
    const { data, error } = await getSupabaseAdmin()
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
