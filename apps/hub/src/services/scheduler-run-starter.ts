import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import type { StartWorkflowRunFn } from "./scheduler";
import type { WorkflowRunStarter } from "./workflow-run-starter";
import { deliverStartIntakeSignal } from "../lib/scheduled-intake";

const log = getLogger(["services", "scheduler-run-starter"]);

// The scheduler's `startWorkflowRun` fire handler (index.ts wires this
// straight into `createScheduler({ startWorkflowRun })`), extracted so it is
// importable and testable on its own — index.ts's module-scope bootstrap
// otherwise makes the real closure untestable, which is exactly how CL-4548's
// scheduler-side wiring (the wrong `fire.kind`/`result.runId` shape) went
// unverified: `scheduled-workflow-gate-success.integration.test.ts` hand-rolls
// its own `startWorkflowRun` stub inside `createScheduler({...})` and never
// exercises this real function.
//
// Trigger-payload enrichment (member identity, current brief-source
// preferences, the incremental since-last-fire lookback) happens INSIDE
// `runStarter.startRun` — the one shared application point every start door
// funnels through (trigger-payload-enrichment-registry.ts). This closure's
// only job is forwarding the schedule's real fire-time window so the
// registry's heartbeat enricher computes the real "since yesterday"
// `createdAfter` instead of the flat 7-day fallback every other
// (non-scheduler) start door gets. Heartbeat is always a daily
// (intervalMinutes=1440) cadence, and for that cadence the window index IS
// the UTC day index (see scheduler.test.ts), so `lastFiredWindowIndex` maps
// directly onto the enricher's day-granularity `lastFiredDayUtc`.
// `anchorMinuteUtc` is forwarded at its real minute precision (CL-4278).
//
// After a successful start, auto-delivers the stored intake so the scheduled
// run passes its first gate without a human (CL-3509) — the SAME shared
// helper the manual-start door calls (CL-4548).
export function createSchedulerStartWorkflowRun(deps: {
  db: HubDb;
  runStarter: WorkflowRunStarter;
}): StartWorkflowRunFn {
  return async (fire) => {
    const result = await deps.runStarter.startRun({
      kind: fire.kind,
      tenantId: fire.tenantId,
      input: fire.triggerPayload,
      creatorPrincipalId: fire.creatorPrincipalId,
      source: "scheduler",
      heartbeatFire: {
        lastFiredDayUtc: fire.lastFiredWindowIndex,
        anchorMinuteUtc: fire.anchorMinuteUtc,
      },
    });
    if (!result.ok) {
      throw new Error(`run-start ${result.reason}: ${result.message}`);
    }
    await deliverStartIntakeSignal(deps.db, {
      runId: result.runId,
      kind: fire.kind,
      triggerPayload: fire.triggerPayload,
    }).catch((err) => {
      log.error("scheduler: intake auto-delivery failed", {
        scheduleKind: fire.kind,
        runId: result.runId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
    return {
      deploymentId: result.deploymentId,
      accepted: true,
      runId: result.runId,
    };
  };
}
