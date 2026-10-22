"use client";

import { useEffect, useReducer, useRef } from "react";
import { isAbort } from "@/lib/api-client";
import { copilotReducer, INITIAL_COPILOT_STATE, requestCopilotReport } from "@/lib/copilot";
import { Button, Icon, Mono, Notice, Panel } from "@/components/ui";

/**
 * On-demand AI summary of one alert's 24-hour, two-hop network. Groq is only
 * called when the analyst presses the button; the rest of the page never
 * waits on it.
 */
export function CopilotPanel({ alertId }: { alertId: string }) {
  const [state, dispatch] = useReducer(copilotReducer, INITIAL_COPILOT_STATE);
  const controller = useRef<AbortController | null>(null);

  // A different alert starts fresh; leaving the page cancels a request.
  useEffect(() => {
    dispatch({ type: "reset" });
    return () => controller.current?.abort();
  }, [alertId]);

  async function generate() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    dispatch({ type: "start" });
    try {
      dispatch({ type: "success", report: await requestCopilotReport(alertId, current.signal) });
    } catch (error) {
      if (!isAbort(error)) dispatch({ type: "failure", error });
    }
  }

  const loading = state.status === "loading";

  return (
    <Panel className="p-4" aria-live="polite">
      <p className="flex items-center gap-1.5 font-semibold">Analyst Copilot</p>
      <p className="mt-0.5 text-xs text-ink-3">
        Alert <Mono>{alertId.slice(0, 8)}</Mono> · transfers within 24 simulated hours, two hops
      </p>

      {state.status === "idle" && (
        <>
          <p className="mt-3 text-ink-2">
            Summarise how money moved around this alert. The server reads the network from the database and sends a
            reduced, anonymised version to the AI model.
          </p>
          <Button className="mt-3" variant="primary" size="sm" onClick={() => void generate()}>
            Generate AI Report
          </Button>
        </>
      )}

      {loading && (
        <Button className="mt-3" variant="primary" size="sm" busy>
          Generating report…
        </Button>
      )}

      {state.status === "error" && (
        <Notice
          tone="danger"
          className="mt-3"
          title="Report not generated"
          action={
            state.retryable && (
              <Button size="sm" onClick={() => void generate()}>
                Retry
              </Button>
            )
          }
        >
          {state.message}
        </Notice>
      )}

      {state.status === "success" && (
        <div className="mt-3 space-y-3">
          <ul className="list-disc space-y-1.5 pl-5 text-ink-2">
            {state.report.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
          <dl className="grid grid-cols-2 gap-2 text-[0.8125rem]">
            <div>
              <dt className="text-xs text-ink-3">Sender&apos;s receivers (24 h)</dt>
              <dd className="tabular-nums">{state.report.observed.sender_distinct_receivers_in_window}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Onward transfers</dt>
              <dd className="tabular-nums">{state.report.observed.onward_transfers_from_receiver}</dd>
            </div>
          </dl>
          {state.report.observed.truncated && (
            <p className="text-xs text-ink-3">Some transactions were left out to keep the input small.</p>
          )}
          <p className="text-xs text-ink-3">
            {state.report.disclaimer} Model {state.report.model}.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void generate()}>
            <Icon name="refresh" /> Regenerate
          </Button>
        </div>
      )}
    </Panel>
  );
}
