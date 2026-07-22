import type { HubDb } from "../db";
import { readMemberPreferences } from "../lib/member-preferences";
import {
  enrichHeartbeatTriggerPayload,
  type HeartbeatMemberIdentity,
} from "../lib/heartbeat-trigger-payload";
import {
  enrichProspectEngineTriggerPayload,
  resolveEnabledBriefSources,
} from "@workbench/shared";

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

/**
 * Fire-time context a caller of `enrichTriggerPayloadForStart` MAY carry —
 * currently only meaningful to the heartbeat enricher's lookback choice. Every
 * start door except the scheduler defaults to `"manual-refresh"` (a full
 * 7-day lookback): the scheduler is the only caller with a real
 * "since-last-fire" window to offer, so it is the only one that passes
 * `lastFiredDayUtc`/`hourUtc`/`"scheduled"` explicitly.
 */
export type TriggerPayloadEnrichmentCtx = {
  kind: string;
  tenantId: string;
  principalId: string;
  lastFiredDayUtc?: number | null;
  hourUtc?: number;
  lookback?: "scheduled" | "manual-refresh";
};

type TriggerPayloadEnricher = (
  deps: TriggerPayloadEnrichmentDeps,
  ctx: TriggerPayloadEnrichmentCtx,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// Per-workflow-kind trigger-payload defaults, applied uniformly by every
// workflow-start implementation — `startWorkflowRun` (`./run-exec.ts`, the
// generic `/workflow-exec/:kind/start` HTTP route and the `workflow_start`
// hub tool) AND `createWorkflowRunStarter` (`../services/workflow-run-starter.ts`,
// webhook triggers, the scheduler, and the heartbeat manual-run route). This
// is the ONE application point: no caller builds its own trigger-payload
// enrichment anymore, so there is exactly one place that can drift from the
// contract a workflow's steps depend on. A kind absent from this map passes
// its input through unchanged.
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
      ctx.lastFiredDayUtc ?? null,
      ctx.hourUtc ?? 0,
      ctx.lookback ?? "manual-refresh",
      identity,
    );
  },
  // Overnight prospect engine (CL-3497): stamp ET runDate + artifact title,
  // resolve mail identity, coerce Engine list ids from schedule strings to
  // integers Sumble write tools accept.
  "prospect-engine": async (deps, ctx, input) => {
    const identity = await deps.resolveUserIdentity(ctx.principalId);
    return enrichProspectEngineTriggerPayload(
      input,
      (deps.now ?? Date.now)(),
      {
        userAddress: identity.userAddress,
        userRefId: identity.userRefId,
      },
      ctx.lookback ?? "manual-refresh",
    );
  },
};

/**
 * Apply the registered trigger-payload enrichment for `ctx.kind`, if any.
 * Kinds with no registered enricher pass `input` through unchanged.
 */
export async function enrichTriggerPayloadForStart(
  deps: TriggerPayloadEnrichmentDeps,
  ctx: TriggerPayloadEnrichmentCtx,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const enricher = TRIGGER_PAYLOAD_ENRICHERS[ctx.kind];
  if (enricher === undefined) return input;
  return enricher(deps, ctx, input);
}
