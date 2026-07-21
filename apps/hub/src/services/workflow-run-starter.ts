import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getAncestorChain } from "@intx/db";
import { getLogger } from "@intx/log";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import type { SessionService } from "@intx/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import type { ProvisionRunDeploymentFn } from "../routes/workflow-runs";
import type { ReclaimDeploymentFn } from "./workflow-deploy";
import { slidingWindowLimiter } from "../lib/sliding-window";
import { mintWorkflowRunId } from "../workflow-executor/mint-workflow-run-id";
import {
  enrichTriggerPayloadForStart,
  type TriggerPayloadEnrichmentDeps,
} from "../workflow-executor/trigger-payload-enrichment-registry";
import {
  failRunIfStillProvisioning,
  insertRunRecord,
  setRunDeployment,
} from "../workflow-executor/run-store";

const log = getLogger(["services", "workflow-run-starter"]);

// Per-tenant ceiling on run starts per rolling hour. This is the choke point
// every trigger path (webhook, scheduler, manual) funnels through, so it is
// the one place that closes off amplification — a webhook flood defeats the
// per-(ip,triggerId) rate limit by spreading across many triggers or IPs,
// but every one of those still calls startRun for the same tenant. 60/hour
// is one run per minute sustained, comfortably above legitimate manual/
// scheduled traffic and far below what a runaway trigger loop would produce.
const WORKFLOW_MAX_STARTS_PER_HOUR_PER_TENANT = 60;
const WORKFLOW_START_WINDOW_MS = 60 * 60 * 1000;

// Callable run-start: resolves a published workflow kind along the tenant
// chain, provisions a FRESH per-run deployment (pins + stages step tool
// packages), and delivers the trigger payload as the mail-trigger message
// that begins a run. Extracted from the HTTP handler so the hub scheduler can
// fire runs without an HTTP self-call.
//
// CL-4069: this used to REUSE the catalog's long-lived deploymentId and only
// call `ensureDeploymentRoutable` (supervisor re-establish). That path never
// restages step tool packages, so after a hub redeploy heartbeat steps saw
// only local tools (posix + mail) and failed with "tool not pinned". Starts
// now await `provisionRunDeployment` (same pin/stage contract as catalog
// start) so callers learn provision failure before returning. Catalog HTTP
// start backgrounds the same work for request latency.
//
// HTTP-only concerns (user context, 403, JSON parse, StartRunBody validation,
// status codes) stay in the route; this service takes an already-resolved
// tenantId + validated trigger input and returns a discriminated result.
export type StartRunInput = {
  kind: string;
  tenantId: string;
  input: Record<string, unknown>;
  // Attribution for the run: the principal on whose behalf the run
  // fires. The HTTP route omits it and the resolved definition's own principal
  // is used (preserving prior behavior); the scheduler passes the
  // schedule's owning member principal so a scheduled run is attributed to its
  // owner, not to the shared catalog definition.
  creatorPrincipalId?: string;
  // The trigger path that requested the run. The per-tenant start budget
  // exists to stop amplification (webhook floods, runaway trigger loops);
  // the daily scheduler is self-limiting — one fire per schedule row per UTC
  // day — and its rows share one workbench tenant with a common brief hour,
  // so budgeting it would silently drop the 61st member's brief for the day.
  // Scheduler-sourced starts bypass the budget.
  source?: "scheduler" | "webhook" | "manual";
  // Pre-computed tenant ancestor chain (most-specific-first). The HTTP run
  // route already walks the chain for its deny-gate check; passing it avoids a
  // redundant getAncestorChain round-trip. When omitted, the starter walks it.
  chain?: string[];
  // The scheduler's real fire-time window (its schedule row's last-fire day +
  // hour) — the only caller with a genuine "since-last-fire" window to offer.
  // Forwarded into the trigger-payload enrichment registry's `ctx` so the
  // heartbeat enricher computes the real incremental lookback
  // (`computeHeartbeatCreatedAfter`) instead of defaulting to the flat 7-day
  // `manual-refresh` window every other source uses. Only meaningful with
  // `source: "scheduler"`.
  heartbeatFire?: { lastFiredDayUtc: number | null; hourUtc: number };
};

export type StartRunResult =
  | { ok: true; deploymentId: string; runId: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "provision_failed"
        | "attach_failed"
        | "delivery_failed"
        | "rate_limited";
      message: string;
    };

export interface WorkflowRunStarter {
  startRun(args: StartRunInput): Promise<StartRunResult>;
}

async function reclaimStartDeployment(args: {
  reclaimDeployment: ReclaimDeploymentFn | undefined;
  deploymentId: string;
  tenantId: string;
  runId: string;
  reason: string;
}): Promise<void> {
  if (!args.reclaimDeployment) return;
  await args
    .reclaimDeployment({
      deploymentId: args.deploymentId,
      tenantId: args.tenantId,
      reason: `start ${args.reason} for run ${args.runId}`,
    })
    .catch((reclaimErr) => {
      log.warn("start-path reclaim failed", {
        runId: args.runId,
        deploymentId: args.deploymentId,
        reason: args.reason,
        error:
          reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr),
      });
    });
}

export function createWorkflowRunStarter(deps: {
  db: HubDb;
  sessionService: SessionService;
  // Fresh per-run deploy: reads the published definition, pins step tool
  // packages from capabilities, stages them into the sidecar deploy tree, and
  // deploys the supervisor. Replaces the prior ensureDeploymentRoutable reuse
  // of a long-lived catalog deployment (CL-4069).
  provisionRunDeployment: ProvisionRunDeploymentFn;
  deploymentDomain: string;
  cryptoProvider: CryptoProvider;
  // Threaded into the same kind-registered trigger-payload enrichment every
  // other start door applies (trigger-payload-enrichment-registry.ts) — this
  // starter backs webhook triggers, the scheduler, AND the heartbeat manual-run
  // route, none of which build their own enrichment anymore.
  resolveUserIdentity: TriggerPayloadEnrichmentDeps["resolveUserIdentity"];
  // Optional: tear down a provisioned deployment when start fails after the
  // deploy was minted (same contract as run-exec's abandoned-deployment reclaim).
  reclaimDeployment?: ReclaimDeploymentFn;
  /** Clock injection point for the per-tenant start-budget window in tests. */
  now?: () => number;
}): WorkflowRunStarter {
  const startBudget = slidingWindowLimiter(
    WORKFLOW_MAX_STARTS_PER_HOUR_PER_TENANT,
    WORKFLOW_START_WINDOW_MS,
    deps.now,
  );

  async function startRun({
    kind,
    tenantId,
    input,
    creatorPrincipalId,
    source,
    chain: precomputedChain,
    heartbeatFire,
  }: StartRunInput): Promise<StartRunResult> {
    if (source !== "scheduler" && !startBudget.tryAcquire(tenantId)) {
      log.error("workflow run-start budget exceeded", {
        kind,
        tenantId,
        maxStartsPerHour: WORKFLOW_MAX_STARTS_PER_HOUR_PER_TENANT,
      });
      return {
        ok: false,
        reason: "rate_limited",
        message: "too many workflow run starts for this workbench",
      };
    }

    const chain =
      precomputedChain ?? (await getAncestorChain(deps.db, tenantId));

    // Resolve a published kind definition for metadata (tenant, principal,
    // kind). Require status `deployed` and a non-null catalog deploymentId —
    // both are set by publish. Catalog resolveDeployment historically filtered
    // only on deploymentId (for reuse); we keep status as the publish marker
    // and still require deploymentId so half-published rows cannot start.
    // The catalog deploymentId is NOT reused for the run — fresh provision
    // below mints a per-run deploy.
    const candidates = await deps.db.query.workflowRun.findMany({
      where: and(
        eq(workflowRun.kind, kind),
        eq(workflowRun.status, "deployed"),
        isNotNull(workflowRun.deploymentId),
        inArray(workflowRun.tenantId, chain),
        isNull(workflowRun.deletedAt),
      ),
      orderBy: desc(workflowRun.createdAt),
    });

    // Shadowing rule: when the same kind is published in several tenants along
    // the chain, the most-specific tenant wins (active workbench shadows an
    // inherited global deployment). `chain` is ordered most-specific-first, so
    // the lowest chain index is most specific; ties break on recency (findMany
    // is already ordered createdAt desc, so the first match at a rank wins).
    const chainRank = new Map(
      chain.map((candidateTenantId, index) => [candidateTenantId, index]),
    );
    let definition: (typeof candidates)[number] | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const current of candidates) {
      const rank = chainRank.get(current.tenantId) ?? Number.POSITIVE_INFINITY;
      if (rank < bestRank) {
        bestRank = rank;
        definition = current;
      }
    }
    if (!definition) {
      return {
        ok: false,
        reason: "not_found",
        message: `no deployed workflow of kind "${kind}"`,
      };
    }

    const runId = mintWorkflowRunId();
    const runPrincipalId = creatorPrincipalId ?? definition.principalId;
    const enrichedInput = await enrichTriggerPayloadForStart(
      {
        db: deps.db,
        resolveUserIdentity: deps.resolveUserIdentity,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      },
      {
        kind: definition.kind,
        tenantId: definition.tenantId,
        principalId: runPrincipalId,
        ...(source === "scheduler"
          ? {
              lastFiredDayUtc: heartbeatFire?.lastFiredDayUtc ?? null,
              hourUtc: heartbeatFire?.hourUtc ?? 0,
              lookback: "scheduled" as const,
            }
          : {}),
      },
      input,
    );
    const triggerPayload = { ...enrichedInput, runId };

    // Durable-first: run row exists (provisioning, no deployment yet) before
    // provision so a mid-start crash is visible as a failed/provisioning run.
    await insertRunRecord(deps.db, {
      runId,
      deploymentId: null,
      kind: definition.kind,
      tenantId: definition.tenantId,
      principalId: runPrincipalId,
      input: triggerPayload,
      originConversationId: null,
      status: "provisioning",
      // Mark scheduler-fired runs so the stalled-run reconciler can fail one
      // parked past its timeout without touching interactive runs (CL-3509).
      ...(source === "scheduler" ? { triggerSource: "scheduler" } : {}),
    });

    // Fresh per-run deployment: pins + stages step tool packages from the
    // current definition + package registry (CL-4069). Catalog principal is
    // the deployer (matches startWorkflowRun / provisionRunDeployment).
    let deploymentId: string;
    try {
      ({ deploymentId } = await deps.provisionRunDeployment({
        kind: definition.kind,
        tenantId: definition.tenantId,
        creatorPrincipalId: definition.principalId,
      }));
    } catch (err) {
      await failRunIfStillProvisioning(deps.db, runId).catch(() => {});
      log.error("workflow run-start provision failed", {
        kind,
        runId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return {
        ok: false,
        reason: "provision_failed",
        message: "failed to start workflow run",
      };
    }

    try {
      await setRunDeployment(deps.db, runId, deploymentId);
    } catch (err) {
      await failRunIfStillProvisioning(deps.db, runId).catch(() => {});
      await reclaimStartDeployment({
        reclaimDeployment: deps.reclaimDeployment,
        deploymentId,
        tenantId: definition.tenantId,
        runId,
        reason: "attach failed",
      });
      log.error("workflow run-start attach failed", {
        kind,
        runId,
        deploymentId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return {
        ok: false,
        reason: "attach_failed",
        message: "failed to start workflow run",
      };
    }

    try {
      await deps.sessionService.sendUserMessage({
        agentAddress: deriveDeploymentAddress({
          deploymentId,
          deploymentDomain: deps.deploymentDomain,
        }),
        from: `hub@${deps.deploymentDomain}`,
        messageId: runId,
        date: new Date(),
        content: JSON.stringify(triggerPayload),
        sessionId: randomUUID(),
        tenantId: definition.tenantId,
        cryptoProvider: deps.cryptoProvider,
      });
    } catch (err) {
      // Only reclaim when we still own the fail flip — if projection already
      // advanced the run, tearing down the deploy would kill a live attach.
      const flipped = await failRunIfStillProvisioning(deps.db, runId).catch(
        () => false,
      );
      if (flipped) {
        await reclaimStartDeployment({
          reclaimDeployment: deps.reclaimDeployment,
          deploymentId,
          tenantId: definition.tenantId,
          runId,
          reason: "delivery failed",
        });
      }
      log.error("workflow run-start delivery failed", {
        kind,
        runId,
        deploymentId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return {
        ok: false,
        reason: "delivery_failed",
        message: "failed to start workflow run",
      };
    }

    // Keep the catalog "deployed" row alive for kind resolution. The per-run
    // deployment is tracked only on this start's workflow_run_record row.
    return { ok: true, deploymentId, runId };
  }

  return { startRun };
}
