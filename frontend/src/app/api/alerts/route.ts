import { connection, NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { authenticateRequest } from "@/lib/server/auth";
import { createTimer } from "@/lib/server/timing";
import { PAGE_SIZE, parseFilters } from "@/lib/alert-filters";
import { MODEL_ALERT_REASON, PAYSIM_ALERT_REASON_PREFIX } from "@/lib/risk";

const NO_STORE = { "Cache-Control": "no-store" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST `or` filters for each alert source. The values are constants, so
// building the filter string here cannot be influenced by request input.
const MODEL_REASON = `reason.eq."${MODEL_ALERT_REASON}"`;
const PAYSIM_REASON = `reason.like."${PAYSIM_ALERT_REASON_PREFIX}*"`;

const ALERT_COLUMNS = "id, transaction_id, severity, status, risk_score, reason, created_at";

const TRANSACTION_COLUMNS = [
  "id",
  "external_transaction_id",
  "source_account_id",
  "destination_account_id",
  "transaction_type",
  "amount",
  "transaction_step",
  "predicted_is_fraud",
  "model_score",
  "model_version",
  "metadata",
  "created_at",
].join(", ");

type AlertRow = {
  id: string;
  transaction_id: string;
  severity: string | null;
  status: string | null;
  risk_score: number | string | null;
  reason: string | null;
  created_at: string;
};

type AlertTransactionRow = {
  id: string;
  external_transaction_id: string | null;
  source_account_id: string | null;
  destination_account_id: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | string | null;
  model_version: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

/**
 * Escapes LIKE wildcards so user input is matched literally. PostgREST also
 * accepts `*` as an alias for `%`, so it is escaped too.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_*]/g, (character) => `\\${character}`);
}

function serverError(message: string) {
  return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  await connection();

  const timer = createTimer();

  try {
    const auth = await timer.measure("auth", () => authenticateRequest(request));
    if (!auth.ok) return auth.response;

    const supabaseAdmin = getSupabaseAdmin();
    const filters = parseFilters(request.nextUrl.searchParams);
    // The open/investigating summary is unfiltered and only changes when a
    // status changes, so clients skip it while paging (`summary=0`).
    const includeSummary = request.nextUrl.searchParams.get("summary") !== "0";
    const uuidSearch = filters.q !== "" && UUID.test(filters.q);
    const textSearch = filters.q !== "" && !uuidSearch;

    // A UUID may be an alert ID or a transaction ID. Resolve an alert ID to
    // its transaction so one `in` filter covers both.
    let searchTransactionIds: string[] | null = null;
    if (uuidSearch) {
      const { data: byAlert, error: lookupError } = await supabaseAdmin
        .from("alerts")
        .select("transaction_id")
        .eq("id", filters.q)
        .limit(1);

      if (lookupError) {
        console.error("Alert ID lookup failed:", lookupError.message);
        return serverError("Could not search alerts.");
      }

      searchTransactionIds = [filters.q, ...(byAlert ?? []).map((row) => row.transaction_id as string)];
    }

    // The transaction is embedded through the alerts.transaction_id foreign
    // key, so a page is one request. A text search turns the embed into an
    // inner join filtered on the transaction reference.
    const embed = `transaction:transactions${textSearch ? "!inner" : ""}(${TRANSACTION_COLUMNS})`;

    // A fresh builder per call: PostgREST builders are single-use.
    const buildQuery = () => {
      let query = supabaseAdmin
        .from("alerts")
        .select(`${ALERT_COLUMNS}, ${embed}`, { count: "exact" })
        .neq("status", "resolved");

      if (filters.status !== "all") query = query.eq("status", filters.status);
      if (filters.severity !== "all") query = query.eq("severity", filters.severity);

      query = query.or(
        filters.source === "model_prediction"
          ? MODEL_REASON
          : filters.source === "ground_truth_demo"
            ? PAYSIM_REASON
            : `${MODEL_REASON},${PAYSIM_REASON}`
      );

      if (searchTransactionIds) query = query.in("transaction_id", searchTransactionIds);
      if (textSearch) {
        query = query.ilike("transaction.external_transaction_id", `%${likeLiteral(filters.q)}%`);
      }

      query =
        filters.sort === "risk"
          ? query
              .order("risk_score", { ascending: false, nullsFirst: false })
              .order("created_at", { ascending: false })
          : query.order("created_at", { ascending: filters.sort === "oldest" });

      // Tie-breaker keeps page boundaries stable when timestamps collide.
      return query.order("id", { ascending: true });
    };

    const fetchPage = (page: number) => buildQuery().range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    const [firstPage, openResult, investigatingResult] = await Promise.all([
      timer.measure("page", () => fetchPage(filters.page)),
      includeSummary
        ? timer.measure("count_open", () =>
            supabaseAdmin.from("alerts").select("id", { count: "exact", head: true }).eq("status", "open")
          )
        : null,
      includeSummary
        ? timer.measure("count_investigating", () =>
            supabaseAdmin.from("alerts").select("id", { count: "exact", head: true }).eq("status", "investigating")
          )
        : null,
    ]);

    // PostgREST rejects a range past the last matching row (for example after
    // alerts were resolved elsewhere). Serve the last page of the same filtered
    // result instead of an error.
    let page = filters.page;
    let pageResult = firstPage;
    if (pageResult.error?.code === "PGRST103") {
      const { count, error: countError } = await buildQuery().limit(1);
      if (countError) {
        console.error("Alert count failed:", countError.message);
        return serverError("Could not load alerts from the database.");
      }
      page = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
      pageResult = await fetchPage(page);
    }

    if (pageResult.error || openResult?.error || investigatingResult?.error) {
      console.error(
        "Alert query failed:",
        pageResult.error?.message ?? openResult?.error?.message ?? investigatingResult?.error?.message
      );
      return serverError("Could not load alerts from the database.");
    }

    const total = pageResult.count ?? 0;
    const alerts = (pageResult.data ?? []) as unknown as Array<AlertRow & { transaction: AlertTransactionRow | null }>;

    // The reason filter selects candidates; the linked transaction confirms
    // them. A model alert needs a stored positive prediction and a PaySim
    // alert needs the isFraud label, otherwise it is reported as unverified.
    let unverified = 0;
    const queue = alerts.flatMap((alert) => {
      const transaction = alert.transaction ?? null;
      const metadata = transaction?.metadata;

      const isModelPrediction = alert.reason === MODEL_ALERT_REASON && transaction?.predicted_is_fraud === true;
      const isPaySimDemo =
        typeof alert.reason === "string" &&
        alert.reason.startsWith(PAYSIM_ALERT_REASON_PREFIX) &&
        metadata?.dataset === "PaySim" &&
        String(metadata?.ground_truth_is_fraud ?? "") === "1";

      if (!isModelPrediction && !isPaySimDemo) {
        unverified += 1;
        return [];
      }

      return [
        {
          ...alert,
          transaction,
          alert_source: isModelPrediction ? ("model_prediction" as const) : ("ground_truth_demo" as const),
        },
      ];
    });

    return NextResponse.json(
      {
        alerts: queue,
        page,
        pageSize: PAGE_SIZE,
        total,
        pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        summary:
          openResult && investigatingResult
            ? { open: openResult.count ?? 0, investigating: investigatingResult.count ?? 0 }
            : undefined,
        unverified,
      },
      { headers: { ...NO_STORE, "Server-Timing": timer.header() } }
    );
  } catch (error) {
    console.error("Unexpected alert API error:", error);
    return serverError("An unexpected error occurred while loading alerts.");
  }
}
