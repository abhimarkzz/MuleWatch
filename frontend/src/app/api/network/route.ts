import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase-admin";

type NetworkRow = {
  transaction_id: string;
  source_account_id: string;
  destination_account_id: string;
  amount: number | string | null;
  transaction_type: string | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | string | null;
  metadata: Record<string, unknown> | null;
  hop: number;
};

type GraphNode = {
  id: string;
  name: string;
  label: string;
  model_flagged: boolean;
  ground_truth_demo: boolean;
  risk_level: "model_flagged" | "ground_truth_demo" | "normal";
};

type NetworkLink = {
  id: string;
  source: string;
  target: string;
  amount: number;
  type: string;
  transaction_type: string;
  transaction_step: number | null;
  model_score: number | null;
  model_flagged: boolean;
  ground_truth_demo: boolean;
  hop: number;
  in_suspicious_model_path: boolean;
  in_paysim_demo_path: boolean;
  path_count: number;
};

type TwoHopPath = {
  id: string;
  source: string;
  intermediary: string;
  destination: string;
  transaction_ids: string[];
  model_flagged_signal: boolean;
  paysim_demo_signal: boolean;
  classification: "model_flagged" | "paysim_demo" | "unflagged";
};

function toFiniteNumber(
  value: number | string | null
): number | null {
  if (value === null) return null;

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;
}

export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

    const publicKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !publicKey) {
      return NextResponse.json(
        { error: "Supabase public environment variables are missing." },
        { status: 500 }
      );
    }

    // Authenticate the dashboard user before reading graph data.
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

    // Execute the recursive PostgreSQL CTE through Supabase RPC.
    const { data, error } = await supabaseAdmin.rpc(
      "get_mulewatch_two_hop_transactions",
      { edge_limit: 100 }
    );

    if (error) {
      console.error(
        "MuleWatch network RPC failed:",
        error.message
      );

      return NextResponse.json(
        { error: "Could not load the transaction network." },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as NetworkRow[];

    const nodesById = new Map<string, GraphNode>();
    const links: NetworkLink[] = [];

    function ensureNode(id: string): GraphNode {
      let node = nodesById.get(id);

      if (!node) {
        const name = `Account ${id.slice(0, 8)}`;

        node = {
          id,
          name,
          label: name,
          model_flagged: false,
          ground_truth_demo: false,
          risk_level: "normal",
        };

        nodesById.set(id, node);
      }

      return node;
    }

    // Build graph nodes and transaction links.
    for (const row of rows) {
      if (
        !row.source_account_id ||
        !row.destination_account_id
      ) {
        continue;
      }

      const source = ensureNode(row.source_account_id);
      const target = ensureNode(row.destination_account_id);

      const modelFlagged = row.predicted_is_fraud === true;
      const metadata = row.metadata ?? {};

      const groundTruthDemo =
        metadata.dataset === "PaySim" &&
        String(metadata.ground_truth_is_fraud) === "1";

      // Mark accounts connected to flagged transactions.
      source.model_flagged ||= modelFlagged;
      target.model_flagged ||= modelFlagged;

      source.ground_truth_demo ||= groundTruthDemo;
      target.ground_truth_demo ||= groundTruthDemo;

      links.push({
        id: row.transaction_id,
        source: row.source_account_id,
        target: row.destination_account_id,
        amount: toFiniteNumber(row.amount) ?? 0,
        type: row.transaction_type ?? "UNKNOWN",
        transaction_type: row.transaction_type ?? "UNKNOWN",
        transaction_step: row.transaction_step,
        model_score: toFiniteNumber(row.model_score),
        model_flagged: modelFlagged,
        ground_truth_demo: groundTruthDemo,
        hop: row.hop,
        in_suspicious_model_path: false,
        in_paysim_demo_path: false,
        path_count: 0,
      });
    }

    // Find connected two-transaction paths.
    // Unflagged paths are retained for investigation but are
    // not classified as suspicious.
    const twoHopPaths: TwoHopPath[] = [];

    const firstHopLinks = links.filter(
      (link) => link.hop === 1
    );

    const secondHopLinks = links.filter(
      (link) => link.hop === 2
    );

    // Index second-hop transactions by source account.
    const secondHopBySource = new Map<string, NetworkLink[]>();

    for (const link of secondHopLinks) {
      const outgoing = secondHopBySource.get(link.source) ?? [];

      outgoing.push(link);
      secondHopBySource.set(link.source, outgoing);
    }

    for (const first of firstHopLinks) {
      // A path follows:
      // source -> intermediary -> destination
      const nextTransactions =
        secondHopBySource.get(first.target) ?? [];

      for (const second of nextTransactions) {
        // Avoid repeated transactions and simple circular paths.
        if (
          first.id === second.id ||
          first.source === second.target
        ) {
          continue;
        }

        const modelSignal =
          first.model_flagged || second.model_flagged;

        const demoSignal =
          first.ground_truth_demo ||
          second.ground_truth_demo;

        const classification: TwoHopPath["classification"] =
          modelSignal
            ? "model_flagged"
            : demoSignal
              ? "paysim_demo"
              : "unflagged";

        twoHopPaths.push({
          id: `${first.id}->${second.id}`,
          source: first.source,
          intermediary: first.target,
          destination: second.target,
          transaction_ids: [first.id, second.id],
          model_flagged_signal: modelSignal,
          paysim_demo_signal: demoSignal,
          classification,
        });

        // Count the number of connected paths involving each link.
        first.path_count += 1;
        second.path_count += 1;

        // Mark paths with actual model evidence.
        if (modelSignal) {
          first.in_suspicious_model_path = true;
          second.in_suspicious_model_path = true;
        }

        // Keep PaySim demonstration evidence separate.
        if (demoSignal) {
          first.in_paysim_demo_path = true;
          second.in_paysim_demo_path = true;
        }
      }
    }

    // Only paths with actual model or PaySim signals belong here.
    const suspiciousPaths = twoHopPaths.filter(
      (path) =>
        path.model_flagged_signal ||
        path.paysim_demo_signal
    );

    // Determine the display risk level for each account.
    const nodes: GraphNode[] = Array.from(
      nodesById.values()
    ).map((node) => ({
      ...node,
      risk_level: node.model_flagged
        ? "model_flagged"
        : node.ground_truth_demo
          ? "ground_truth_demo"
          : "normal",
    }));

    // Calculate statistics.
    const modelFlaggedTransactions = links.filter(
      (link) => link.model_flagged
    ).length;

    const paysimDemoTransactions = links.filter(
      (link) => link.ground_truth_demo
    ).length;

    const modelFlaggedPaths = suspiciousPaths.filter(
      (path) => path.model_flagged_signal
    ).length;

    const paysimDemoPaths = suspiciousPaths.filter(
      (path) => path.paysim_demo_signal
    ).length;

    const unflaggedTwoHopPaths = twoHopPaths.filter(
      (path) =>
        !path.model_flagged_signal &&
        !path.paysim_demo_signal
    ).length;

    // Return the graph data and investigation statistics.
    return NextResponse.json(
      {
        nodes,
        links,
        twoHopPaths,
        suspiciousPaths,
        stats: {
          node_count: nodes.length,
          link_count: links.length,

          model_flagged_transactions:
            modelFlaggedTransactions,

          paysim_demo_transactions:
            paysimDemoTransactions,

          max_hop: links.reduce(
            (max, link) => Math.max(max, link.hop),
            0
          ),

          total_two_hop_paths: twoHopPaths.length,

          unflagged_two_hop_paths:
            unflaggedTwoHopPaths,

          suspicious_two_hop_paths:
            modelFlaggedPaths,

          paysim_demo_two_hop_paths:
            paysimDemoPaths,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error("MuleWatch network API error:", error);

    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while loading the network.",
      },
      { status: 500 }
    );
  }
}