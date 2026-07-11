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

const log = getLogger(["services", "workflow-run-starter"]);

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
};

export type StartRunResult =
  | { ok: true; deploymentId: string }
  | { ok: false; reason: "not_found" | "delivery_failed"; message: string };

export interface WorkflowRunStarter {
  startRun(args: StartRunInput): Promise<StartRunResult>;
}

export function createWorkflowRunStarter(deps: {
  db: HubDb;
  sessionService: SessionService;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  deploymentDomain: string;
  cryptoProvider: CryptoProvider;
}): WorkflowRunStarter {
  async function startRun({
    kind,
    tenantId,
    input,
    creatorPrincipalId,
  }: StartRunInput): Promise<StartRunResult> {
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

    try {
      // The supervisor may have been dropped from the hub's addressIndex by a
      // restart since deploy; re-establish it before delivering the trigger so
      // the run does not dead-end on `agent is unreachable` with zero events
      // to avoid dead-ending on `agent is unreachable` with zero events.
      await deps.ensureDeploymentRoutable({
        deploymentId: deployment.deploymentId,
        kind: deployment.kind,
        tenantId: deployment.tenantId,
        creatorPrincipalId: creatorPrincipalId ?? deployment.principalId,
      });
      await deps.sessionService.sendUserMessage({
        agentAddress: deriveDeploymentAddress({
          deploymentId: deployment.deploymentId,
          deploymentDomain: deps.deploymentDomain,
        }),
        from: `hub@${deps.deploymentDomain}`,
        messageId: randomUUID(),
        date: new Date(),
        content: JSON.stringify(input),
        sessionId: randomUUID(),
        tenantId: deployment.tenantId,
        cryptoProvider: deps.cryptoProvider,
      });
    } catch (err) {
      log.error("workflow run-start failed", {
        kind,
        deploymentId: deployment.deploymentId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return {
        ok: false,
        reason: "delivery_failed",
        message: "failed to start workflow run",
      };
    }

    return { ok: true, deploymentId: deployment.deploymentId };
  }

  return { startRun };
}
