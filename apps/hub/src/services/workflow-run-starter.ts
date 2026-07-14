import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getAncestorChain } from "@intx/db";
import { getLogger } from "@intx/log";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import type { SessionService } from "@intx/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import { slidingWindowLimiter } from "../lib/sliding-window";
import {
  failRunIfStillRunning,
  insertRunRecord,
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

// Callable run-start: resolves a deployed workflow by kind along the tenant
// chain, ensures its supervisor is routable, and delivers the trigger payload as
// the mail-trigger message that begins a run. Extracted from the HTTP handler so
// the hub scheduler can fire runs without an HTTP self-call.
// HTTP-only concerns (user context, 403, JSON parse, StartRunBody validation,
// status codes) stay in the route; this service takes an already-resolved
// tenantId + validated trigger input and returns a discriminated result.
export type StartRunInput = {
  kind: string;
  tenantId: string;
  input: Record<string, unknown>;
  // Attribution for the run: the principal on whose behalf the run
  // fires. The HTTP route omits it and the resolved deployment's own principal
  // is used (preserving prior behavior); the scheduler passes the
  // schedule's owning member principal so a scheduled run is attributed to its
  // owner, not to the shared deployment.
  creatorPrincipalId?: string;
  // The trigger path that requested the run. The per-tenant start budget
  // exists to stop amplification (webhook floods, runaway trigger loops);
  // the daily scheduler is self-limiting — one fire per schedule row per UTC
  // day — and its rows share one workbench tenant with a common brief hour,
  // so budgeting it would silently drop the 61st member's brief for the day.
  // Scheduler-sourced starts bypass the budget.
  source?: "scheduler" | "webhook" | "manual";
};

export type StartRunResult =
  | { ok: true; deploymentId: string; runId: string }
  | {
      ok: false;
      reason: "not_found" | "delivery_failed" | "rate_limited";
      message: string;
    };

export interface WorkflowRunStarter {
  startRun(args: StartRunInput): Promise<StartRunResult>;
}

export function createWorkflowRunStarter(deps: {
  db: HubDb;
  sessionService: SessionService;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  deploymentDomain: string;
  cryptoProvider: CryptoProvider;
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

    const chain = await getAncestorChain(deps.db, tenantId);

    const candidates = await deps.db.query.workflowRun.findMany({
      where: and(
        eq(workflowRun.kind, kind),
        inArray(workflowRun.tenantId, chain),
        isNotNull(workflowRun.deploymentId),
        isNull(workflowRun.deletedAt),
      ),
      orderBy: desc(workflowRun.createdAt),
    });

    // Shadowing rule: when the same kind is deployed in several tenants along
    // the chain, the most-specific tenant wins (active workbench shadows an
    // inherited global deployment). `chain` is ordered most-specific-first, so
    // the lowest chain index is most specific; ties break on recency (findMany
    // is already ordered createdAt desc, so the first match at a rank wins).
    const chainRank = new Map(
      chain.map((candidateTenantId, index) => [candidateTenantId, index]),
    );
    let deployment: (typeof candidates)[number] | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const current of candidates) {
      const rank = chainRank.get(current.tenantId) ?? Number.POSITIVE_INFINITY;
      if (rank < bestRank) {
        bestRank = rank;
        deployment = current;
      }
    }
    if (!deployment?.deploymentId) {
      return {
        ok: false,
        reason: "not_found",
        message: `no deployed workflow of kind "${kind}"`,
      };
    }

    const runId = randomUUID();
    const principalId = creatorPrincipalId ?? deployment.principalId;
    const triggerPayload = { ...input, runId };

    try {
      await insertRunRecord(deps.db, {
        runId,
        deploymentId: deployment.deploymentId,
        kind: deployment.kind,
        tenantId: deployment.tenantId,
        principalId,
        input: triggerPayload,
        originConversationId: null,
        // Mark scheduler-fired runs so the stalled-run reconciler can fail one
        // parked past its timeout without touching interactive runs (CL-3509).
        ...(source === "scheduler" ? { triggerSource: "scheduler" } : {}),
      });

      // The supervisor may have been dropped from the hub's addressIndex by a
      // restart since deploy; re-establish it before delivering the trigger so
      // the run does not dead-end on `agent is unreachable` with zero events.
      await deps.ensureDeploymentRoutable({
        deploymentId: deployment.deploymentId,
        kind: deployment.kind,
        tenantId: deployment.tenantId,
        creatorPrincipalId: principalId,
      });
      await deps.sessionService.sendUserMessage({
        agentAddress: deriveDeploymentAddress({
          deploymentId: deployment.deploymentId,
          deploymentDomain: deps.deploymentDomain,
        }),
        from: `hub@${deps.deploymentDomain}`,
        messageId: runId,
        date: new Date(),
        content: JSON.stringify(triggerPayload),
        sessionId: randomUUID(),
        tenantId: deployment.tenantId,
        cryptoProvider: deps.cryptoProvider,
      });
    } catch (err) {
      await failRunIfStillRunning(deps.db, runId, new Date());
      log.error("workflow run-start failed", {
        kind,
        runId,
        deploymentId: deployment.deploymentId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return {
        ok: false,
        reason: "delivery_failed",
        message: "failed to start workflow run",
      };
    }

    return { ok: true, deploymentId: deployment.deploymentId, runId };
  }

  return { startRun };
}
