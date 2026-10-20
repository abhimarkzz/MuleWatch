import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { authenticateRequest } from "@/lib/server/auth";

const ALLOWED_STATUSES = [
  "open",
  "investigating",
  "resolved",
] as const;

type AlertStatus = (typeof ALLOWED_STATUSES)[number];

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const auth = await authenticateRequest(request);
    if (!auth.ok) return auth.response;

    // Validate the alert ID.
    const { id } = await context.params;

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(id)) {
      return NextResponse.json(
        { error: "Invalid alert ID." },
        { status: 400 }
      );
    }

    // Parse the request body.
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must contain valid JSON." },
        { status: 400 }
      );
    }

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      !("status" in body)
    ) {
      return NextResponse.json(
        { error: "A valid status is required." },
        { status: 400 }
      );
    }

    const requestedStatus = body.status;

    // Only permit explicitly supported status values.
    if (
      typeof requestedStatus !== "string" ||
      !ALLOWED_STATUSES.includes(
        requestedStatus as AlertStatus
      )
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid status. Use open, investigating, or resolved.",
        },
        { status: 400 }
      );
    }

    // Update only the requested alert.
    const { data: updatedAlert, error: updateError } =
      await getSupabaseAdmin()
        .from("alerts")
        .update({ status: requestedStatus as AlertStatus })
        .eq("id", id)
        .select("id, status")
        .maybeSingle();

    if (updateError) {
      console.error(
        "Alert status update failed:",
        updateError.message
      );

      return NextResponse.json(
        {
          error:
            "Could not update the alert. Check the database status constraints.",
        },
        { status: 500 }
      );
    }

    if (!updatedAlert) {
      return NextResponse.json(
        { error: "Alert not found." },
        { status: 404 }
      );
    }

    // Return the confirmed database update.
    return NextResponse.json(
      {
        message: "Alert status updated successfully.",
        alert: updatedAlert,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    console.error("Unexpected alert status API error:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred while updating the alert." },
      { status: 500 }
    );
  }
}