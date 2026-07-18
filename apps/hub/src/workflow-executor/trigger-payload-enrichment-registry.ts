import type { HubDb } from "../db";
import { readMemberPreferences } from "../lib/member-preferences";
import {
  enrichHeartbeatTriggerPayload,
  type HeartbeatMemberIdentity,
} from "../lib/heartbeat-trigger-payload";
import { resolveEnabledBriefSources } from "@workbench/shared";

export type TriggerPayloadEnrichmentDeps = {
  db: HubDb;
  // Resolves a principal to the mail identity (+ display name, if known) a
  // trigger payload needs. Shared with the scheduler and the heartbeat manual-
  // run route (apps/hub/src/index.ts, apps/hub/src/routes/me-brief-run.ts).
  resolveUserIdentity: (
    principalId: string,
  ) => Promise<HeartbeatMemberIdentity>;
  // Clock injection for tests; defaults to Date.now.
  now?: () => number;
};

type TriggerPayloadEnricher = (
  deps: TriggerPayloadEnrichmentDeps,
  ctx: { kind: string; tenantId: string; principalId: string },
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// Per-workflow-kind trigger-payload defaults, applied uniformly by
// `startWorkflowRun` (`./run-exec.ts`) — the SINGLE run-start implementation
// shared by the generic `/workflow-exec/:kind/start` HTTP route and the
// `workflow_start` hub tool. Without this, either entrypoint delivers whatever
// bare body the caller supplied straight to the deployment, so a workflow whose
// steps depend on server-resolved facts (the firing member's identity,
// preferences) that no caller can be expected to supply fails deep in step
// dispatch instead of starting correctly. A kind absent from this map
// passes its input through unchanged.
//
// The heartbeat/manual-run route (`me-brief-run.ts`) and the scheduler
// (`apps/hub/src/index.ts`) already build this same enrichment themselves —
// they call `enrichHeartbeatTriggerPayload` directly because each has richer,
// path-specific knowledge (the scheduler's fire-time last-run window; the
// manual route's rate limit) that does not belong in a generic registry. This
// entry exists for every OTHER start door: a heartbeat run kicked off through
// the generic route or the Myra `workflow_start` tool gets the same
// manual-refresh-style enrichment (current prefs, current identity, 7-day
// lookback) instead of nothing.
const TRIGGER_PAYLOAD_ENRICHERS: Record<string, TriggerPayloadEnricher> = {
  heartbeat: async (deps, ctx, input) => {
    const [prefs, identity] = await Promise.all([
      readMemberPreferences(deps.db, ctx.tenantId, ctx.principalId),
      deps.resolveUserIdentity(ctx.principalId),
    ]);
    return enrichHeartbeatTriggerPayload(
      input,
      ctx.kind,
      ctx.kind,
      resolveEnabledBriefSources(prefs),
      (deps.now ?? Date.now)(),
      null,
      0,
      "manual-refresh",
      identity,
    );
  },
};

/**
 * Apply the registered trigger-payload enrichment for `ctx.kind`, if any.
 * Kinds with no registered enricher pass `input` through unchanged.
 */
export async function enrichTriggerPayloadForStart(
  deps: TriggerPayloadEnrichmentDeps,
  ctx: { kind: string; tenantId: string; principalId: string },
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const enricher = TRIGGER_PAYLOAD_ENRICHERS[ctx.kind];
  if (enricher === undefined) return input;
  return enricher(deps, ctx, input);
}
