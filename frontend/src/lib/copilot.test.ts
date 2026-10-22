import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) },
  }),
}));

import { ApiError } from "./api-client";
import { copilotReducer, INITIAL_COPILOT_STATE, requestCopilotReport, type CopilotReport } from "./copilot";

const REPORT: CopilotReport = {
  alert_id: "11111111-2222-4333-8444-555555555555",
  model: "openai/gpt-oss-20b",
  bullets: ["a", "b", "c"],
  observed: { sender_distinct_receivers_in_window: 1, onward_transfers_from_receiver: 0, layering_chain_observed: false, truncated: false },
  window_hours: 24,
  transactions_analysed: 1,
  generated_at: "2026-10-22T00:00:00Z",
  disclaimer: "Not a finding of fraud.",
};

describe("copilot UI state", () => {
  it("moves idle → loading → success", () => {
    const loading = copilotReducer(INITIAL_COPILOT_STATE, { type: "start" });
    expect(loading).toEqual({ status: "loading" });
    expect(copilotReducer(loading, { type: "success", report: REPORT })).toEqual({ status: "success", report: REPORT });
  });

  it("shows a retryable error for a 429 and a final one for a 400", () => {
    const busy = copilotReducer({ status: "loading" }, { type: "failure", error: new ApiError("busy", 429, true) });
    expect(busy).toEqual({ status: "error", message: "busy", retryable: true });
    const bad = copilotReducer({ status: "loading" }, { type: "failure", error: new ApiError("bad id", 400, false) });
    expect(bad).toMatchObject({ retryable: false });
  });

  it("retrying from an error goes back to loading, and reset returns to idle", () => {
    const error = { status: "error" as const, message: "x", retryable: true };
    expect(copilotReducer(error, { type: "start" })).toEqual({ status: "loading" });
    expect(copilotReducer(error, { type: "reset" })).toEqual(INITIAL_COPILOT_STATE);
  });
});

describe("requestCopilotReport", () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the alert ID with the analyst's token", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(REPORT));
    expect(await requestCopilotReport(REPORT.alert_id)).toEqual(REPORT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/copilot");
    expect(JSON.parse(init.body)).toEqual({ alert_id: REPORT.alert_id });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("rejects an incomplete report", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...REPORT, bullets: ["only one"] }));
    await expect(requestCopilotReport(REPORT.alert_id)).rejects.toMatchObject({ status: 502, retryable: true });
  });

  it("passes through the server's rate-limit message", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "The AI service is busy. Try again in a minute.", retryable: true }, { status: 429 }));
    await expect(requestCopilotReport(REPORT.alert_id)).rejects.toMatchObject({ status: 429, retryable: true });
  });
});

describe("UI wiring", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

  it("only calls Groq from the button, never on load", () => {
    const panel = read("components/network/CopilotPanel.tsx");
    expect(panel).toContain("Generate AI Report");
    expect(panel.match(/requestCopilotReport\(/g)).toHaveLength(1);
    expect(panel).toMatch(/async function generate\(\)[\s\S]*requestCopilotReport\(/);
  });

  it("renders the panel beside the graph for an alert deep link", () => {
    expect(read("components/network/NetworkExplorer.tsx")).toContain("<CopilotPanel alertId={copilotAlert} />");
    expect(read("components/alerts/AlertDrawer.tsx")).toContain("&alert=${encodeURIComponent(alert.id)}");
  });
});
