import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDeduper, FRAUD_CHANNEL, subscribeToFraudInserts, toFraudToast } from "./realtime-fraud";

/** In-memory stand-in for the Supabase Realtime client; nothing leaves the process. */
function fakeClient() {
  let insertHandler: ((payload: unknown) => void) | undefined;
  let statusHandler: ((status: string) => void) | undefined;
  const channel = {
    on: vi.fn((_type: string, _filter: unknown, handler: (payload: unknown) => void) => {
      insertHandler = handler;
      return channel;
    }),
    subscribe: vi.fn((cb: (status: string) => void) => {
      statusHandler = cb;
      return channel;
    }),
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => "ok"),
  };
  return {
    client: client as unknown as SupabaseClient,
    raw: client,
    channel,
    insert: (row: Record<string, unknown>) => insertHandler?.({ eventType: "INSERT", new: row }),
    status: (s: string) => statusHandler?.(s),
  };
}

const FLAGGED = {
  id: "tx-1",
  external_transaction_id: "mulewatch-ui-1",
  amount: "9000.5",
  model_score: 0.93,
  predicted_is_fraud: true,
  source_account_id: "aaaaaaaa-0000-4000-8000-000000000001",
  metadata: { secret: "x" },
};

function subscribe() {
  const fake = fakeClient();
  const onFraud = vi.fn();
  const onStatus = vi.fn();
  const cleanup = subscribeToFraudInserts(fake.client, { onFraud, onStatus });
  return { ...fake, onFraud, onStatus, cleanup };
}

describe("subscribeToFraudInserts", () => {
  it("subscribes to INSERTs on public.transactions on the named channel", () => {
    const { raw, channel } = subscribe();
    expect(raw.channel).toHaveBeenCalledWith(FRAUD_CHANNEL);
    expect(FRAUD_CHANNEL).toBe("custom-all-channel");
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "transactions" },
      expect.any(Function),
    );
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
  });

  it("notifies for a fraud insert with only safe display fields", () => {
    const { insert, onFraud } = subscribe();
    insert(FLAGGED);
    expect(onFraud).toHaveBeenCalledTimes(1);
    expect(onFraud).toHaveBeenCalledWith({ id: "tx-1", reference: "mulewatch-ui-1", amount: 9000.5, score: 0.93 });
    expect(JSON.stringify(onFraud.mock.calls)).not.toMatch(/aaaaaaaa|secret/);
  });

  it.each([
    ["not flagged", { ...FLAGGED, predicted_is_fraud: false }],
    ["unscored", { ...FLAGGED, predicted_is_fraud: null }],
    ["truthy but not true", { ...FLAGGED, predicted_is_fraud: "true" }],
    ["missing id", { ...FLAGGED, id: undefined }],
  ])("ignores a %s insert", (_label, row) => {
    const { insert, onFraud } = subscribe();
    insert(row);
    expect(onFraud).not.toHaveBeenCalled();
  });

  it("shows one toast per transaction even if the event repeats", () => {
    const { insert, onFraud } = subscribe();
    insert(FLAGGED);
    insert(FLAGGED);
    insert({ ...FLAGGED, id: "tx-2" });
    expect(onFraud.mock.calls.map(([t]) => t.id)).toEqual(["tx-1", "tx-2"]);
  });

  it("reports connecting, live, reconnecting and closed", () => {
    const { status, onStatus } = subscribe();
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    status("SUBSCRIBED");
    expect(onStatus).toHaveBeenLastCalledWith("live");
    status("CHANNEL_ERROR");
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    status("SUBSCRIBED"); // Realtime rejoined on its own
    expect(onStatus).toHaveBeenLastCalledWith("live");
    status("TIMED_OUT");
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    status("CLOSED");
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });

  it("removes the channel on cleanup", () => {
    const { cleanup, raw, channel } = subscribe();
    cleanup();
    expect(raw.removeChannel).toHaveBeenCalledWith(channel);
  });
});

describe("helpers", () => {
  it("toFraudToast tolerates missing optional fields", () => {
    expect(toFraudToast({ new: { id: "t", predicted_is_fraud: true } })).toEqual({ id: "t", reference: null, amount: null, score: null });
    expect(toFraudToast(null)).toBeNull();
    expect(toFraudToast({})).toBeNull();
  });

  it("the deduper forgets the oldest IDs beyond its limit", () => {
    const isNew = createDeduper(2);
    expect([isNew("a"), isNew("b"), isNew("a"), isNew("c"), isNew("a")]).toEqual([true, true, false, true, true]);
  });
});

describe("UI wiring", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

  it("mounts the notifier only inside the signed-in shell", () => {
    expect(read("components/AppShell.tsx")).toContain("<FraudNotifier userId={session.user.id} />");
    expect(read("app/(workspace)/layout.tsx")).toMatch(/<SessionGate>[\s\S]*<AppShell>/);
  });

  it("uses the browser client, never the service-role key", () => {
    const notifier = read("components/FraudNotifier.tsx") + read("lib/realtime-fraud.ts");
    expect(notifier).toContain("getSupabase()");
    expect(notifier).not.toMatch(/SERVICE_ROLE|supabase-admin|getSupabaseAdmin/);
  });

  it("refreshes the alert queue in place when a fraud insert arrives", () => {
    expect(read("components/alerts/AlertQueue.tsx")).toMatch(/addEventListener\(FRAUD_INSERT_EVENT[\s\S]*removeEventListener\(FRAUD_INSERT_EVENT/);
  });
});
