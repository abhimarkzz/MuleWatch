import { ApiError, apiRequest, errorMessage } from "@/lib/api-client";

export type CopilotReport = {
  alert_id: string;
  model: string;
  bullets: string[];
  observed: {
    sender_distinct_receivers_in_window: number;
    onward_transfers_from_receiver: number;
    layering_chain_observed: boolean;
    truncated: boolean;
  };
  window_hours: number;
  transactions_analysed: number;
  generated_at: string;
  disclaimer: string;
};

export type CopilotState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; report: CopilotReport }
  | { status: "error"; message: string; retryable: boolean };

export type CopilotAction =
  | { type: "start" }
  | { type: "success"; report: CopilotReport }
  | { type: "failure"; error: unknown }
  | { type: "reset" };

export const INITIAL_COPILOT_STATE: CopilotState = { status: "idle" };

export function copilotReducer(state: CopilotState, action: CopilotAction): CopilotState {
  switch (action.type) {
    case "start":
      return { status: "loading" };
    case "success":
      return { status: "success", report: action.report };
    case "failure":
      return {
        status: "error",
        message: errorMessage(action.error, "The AI report could not be generated."),
        retryable: !(action.error instanceof ApiError) || action.error.retryable,
      };
    case "reset":
      return INITIAL_COPILOT_STATE;
  }
}

function isReport(value: unknown): value is CopilotReport {
  const v = value as CopilotReport | null;
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray(v.bullets) &&
    v.bullets.length === 3 &&
    v.bullets.every((b) => typeof b === "string") &&
    typeof v.observed === "object" &&
    v.observed !== null
  );
}

/** Asks the server for a report on one alert; the server builds the graph. */
export async function requestCopilotReport(alertId: string, signal?: AbortSignal): Promise<CopilotReport> {
  const body = await apiRequest<unknown>("/api/copilot", {
    method: "POST",
    body: { alert_id: alertId },
    timeoutMs: 35_000,
    signal,
  });
  if (!isReport(body)) throw new ApiError("The AI report was incomplete. Please retry.", 502, true);
  return body;
}
