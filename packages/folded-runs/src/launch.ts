// Launches a folded interactive run — the same shape and the same
// address family `POST /workflows/runs` produces (see
// `vendor/intx/hub-api/src/routes/instances.ts`, this module's
// reference implementation) — rather than the native
// `sessionService.deployWorkflowDefinition` path. A workflow-deploy
// anchor is a *deployment* run (`workflow_run.deploymentId` set, no
// `principalId`), a different address family than a folded run
// (`deploymentId: null`, `principalId` set, its session found by
// joining `agent_session` on that principal) — the family that makes
// a run's mailbox actually listable through the platform's sanctioned
// per-run surfaces.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import type { DBExecutor } from "@intx/db";
import {
  agentSession,
  principal as principalTable,
  workflowRun,
} from "@intx/db/schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import { resolveDefinitionSources } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import { InferenceSource } from "@intx/types/runtime";
import type { FoldedBody } from "@intx/workflow-deploy";
import type { FoldedRunsDeps } from "./types";

/**
 * Thrown by `deployAtHead` when the tenant catalog yields no launchable
 * inference source for the run's definition. The bare resolution reason
 * (`resolutionMessage`) is kept alongside the expanded human-readable
 * `message` so a caller at the HTTP boundary can map it to a response
 * body without parsing the log-string.
 */
export class InferenceResolutionError extends Error {
  readonly resolutionMessage: string;
  constructor(launchLabel: string, resolutionMessage: string) {
    super(
      `cannot resolve an inference source for ${launchLabel} ` +
        `(${resolutionMessage}); seed a tenant catalog source (provider, ` +
        `credential, catalog model/provider/offering) before launching`,
    );
    this.name = "InferenceResolutionError";
    this.resolutionMessage = resolutionMessage;
  }
}

/**
 * A caller-supplied inference-source chain, used verbatim in place of
 * catalog resolution (see `deployAtHead`). Exists for launches whose
 * anchor never runs a real inference turn — a channel host's noop
 * pin (`@corbits/chat`'s `platform-adapter.ts`) is the only caller
 * today. Validated at the boundary since it crosses from a caller
 * package into this one; a malformed override fails loud rather than
 * reaching `deployInstanceAtHead` with a broken chain.
 */
export const SourcesOverride = type({
  sources: InferenceSource.array().atLeastLength(1),
  defaultSource: "string",
});
export type SourcesOverride = typeof SourcesOverride.infer;

/**
 * Parses `raw` as a `SourcesOverride` when present, throwing loud on a
 * malformed shape rather than letting it reach `deployInstanceAtHead`.
 * `undefined` in, `undefined` out — the ordinary "resolve from the
 * catalog" path.
 */
export function parseSourcesOverride(
  raw: SourcesOverride | undefined,
): SourcesOverride | undefined {
  if (raw === undefined) return undefined;
  const parsed = SourcesOverride(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid inference sources override: ${parsed.summary}`);
  }
  return parsed;
}

/**
 * The deploy-only step shared by a fresh launch (`launchFoldedRun`)
 * and a wake (re-deploying an instance the sidecar no longer has
 * resident): resolve inference sources against the tenant catalog,
 * (re)open the event collector, and call `deployInstanceAtHead`.
 * Callers that just wrote new principal/session/run rows
 * (`launchFoldedRun`) still own their own failure-path rollback of
 * those rows — this function only throws.
 */
export async function deployAtHead(
  deps: Pick<FoldedRunsDeps, "db" | "sessionService" | "eventCollectors">,
  params: {
    tenantId: string;
    instanceId: string;
    triggerAddress: string;
    principalId: string;
    sessionId: string;
    foldedBody: FoldedBody;
    /** Named in the "seed a tenant catalog source" error, e.g. "the channel host", "the invited agent", or "the woken instance". */
    launchLabel: string;
    /**
     * When present, used verbatim in place of `resolveDefinitionSources`
     * — the tenant catalog is never touched, so a launch pinned this
     * way needs no catalog source to exist at all. Absent, this is
     * the ordinary catalog-resolved path every launch used before this
     * override existed.
     */
    sources?: SourcesOverride;
  },
): Promise<void> {
  const sourcesOverride = parseSourcesOverride(params.sources);
  const resolution =
    sourcesOverride !== undefined
      ? { ok: true as const, ...sourcesOverride }
      : await resolveDefinitionSources({
          db: deps.db,
          tenantId: params.tenantId,
          modelRequirements: null,
          fallbackModel: params.foldedBody.model,
          invokerPreferences: {},
        });
  if (!resolution.ok) {
    throw new InferenceResolutionError(params.launchLabel, resolution.message);
  }

  // `create` replaces any collector already registered for this
  // address (see `EventCollectorRegistry.create`), so this is
  // idempotent whether this is a fresh launch or a wake of an instance
  // whose collector never got torn down.
  deps.eventCollectors.create(
    params.triggerAddress,
    params.tenantId,
    params.sessionId,
    params.instanceId,
  );

  await deps.sessionService.deployInstanceAtHead({
    agentAddress: params.triggerAddress,
    agentId: params.instanceId,
    instanceId: params.instanceId,
    config: {
      sessionId: params.sessionId,
      agentId: params.instanceId,
      tenantId: params.tenantId,
      principalId: params.principalId,
      agentAddress: params.triggerAddress,
      systemPrompt: params.foldedBody.systemPrompt,
      tools: [],
      grants: [],
      sources: resolution.sources,
      defaultSource: resolution.defaultSource,
    },
    deployContent: { systemPrompt: params.foldedBody.systemPrompt },
    toolPackagePins: params.foldedBody.toolPackagePins,
  });
}

export type LaunchFoldedRunParams = {
  tenantId: string;
  instanceId: string;
  triggerAddress: string;
  definitionId: string;
  foldedBody: FoldedBody;
  /** Named in the "seed a tenant catalog source" error, e.g. "the channel host" or "the invited agent". */
  launchLabel: string;
  /**
   * When present, used verbatim in place of catalog resolution — see
   * `deployAtHead`'s own doc on the same field.
   */
  sources?: SourcesOverride;
  /**
   * Invoked inside the same launch transaction, immediately after the
   * principal/session/run rows are written, so a caller-owned table
   * (e.g. `@corbits/chat`'s `channel_launch`) commits atomically with
   * them. `folded-runs` never imports the caller's schema — the
   * caller writes its own row through the transaction handle passed
   * here.
   */
  persistExtra?: (tx: DBExecutor) => Promise<void>;
};

export type LaunchedFoldedRun = {
  readonly instancePrincipalId: string;
  readonly sessionId: string;
};

/**
 * The launch core shared by a channel host and an invited agent alike
 * (or any other folded-run launch a host composes): resolve inference
 * sources against the tenant catalog, write the folded run's
 * principal/session/run rows, open the event collector, and deploy via
 * `deployInstanceAtHead` — with the same failure-path cleanup a deploy
 * failure needs. Only how the launch body (`foldedBody`) and the
 * instance's identity (`instanceId`/`triggerAddress`/`definitionId`)
 * are sourced is the caller's concern.
 */
export async function launchFoldedRun(
  deps: FoldedRunsDeps,
  params: LaunchFoldedRunParams,
): Promise<LaunchedFoldedRun> {
  const instancePrincipalId = generateId("principal");
  const sessionId = generateId("session");
  const now = new Date();

  await deps.db.transaction(async (tx) => {
    // A folded run's principal is `workflow`-kind, converging on the
    // native run's principal shape; its `refId` is the instance id,
    // matching `POST /workflows/runs`.
    await tx.insert(principalTable).values({
      id: instancePrincipalId,
      tenantId: params.tenantId,
      kind: "workflow",
      refId: params.instanceId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // The session is keyed to the folded definition (`agentId`) and to
    // the run's own principal — the shared-principal bridge
    // `resolveRunSessionId`/`resolveRunIdForSession` read.
    await tx.insert(agentSession).values({
      id: sessionId,
      tenantId: params.tenantId,
      agentId: params.definitionId,
      principalId: instancePrincipalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // The folded run IS the launched instance: `deploymentId` is null
    // (a folded run has no deployment), which is what puts it in the
    // address family the platform's run-scoped mail surfaces actually
    // resolve.
    await tx.insert(workflowRun).values({
      id: params.instanceId,
      definitionId: params.definitionId,
      deploymentId: null,
      tenantId: params.tenantId,
      principalId: instancePrincipalId,
      address: params.triggerAddress,
      status: "running",
      modelPreferences: null,
      createdAt: now,
    });

    if (params.persistExtra !== undefined) {
      await params.persistExtra(tx);
    }
  });

  try {
    // Opened/deployed via the shared `deployAtHead` step, mirroring
    // the reference route: the run's runtime status/readiness
    // (health, SSE replay) is read off the collector by address, and a
    // launch that never opens one reads as permanently "not_ready" and
    // leaks into the generic instance list with broken health.
    await deployAtHead(deps, {
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      triggerAddress: params.triggerAddress,
      principalId: instancePrincipalId,
      sessionId,
      foldedBody: params.foldedBody,
      launchLabel: params.launchLabel,
      ...(params.sources !== undefined ? { sources: params.sources } : {}),
    });
  } catch (err) {
    // Mirrors the reference route's failure-path cleanup: a deploy
    // failure must not leave the just-committed principal/session/run
    // rows behind as a permanently "running" ghost that nothing is
    // listening on.
    deps.eventCollectors.abandon(params.triggerAddress);

    const failedAt = new Date();

    await deps.db
      .update(agentSession)
      .set({ status: "ended", endedAt: failedAt, updatedAt: failedAt })
      .where(eq(agentSession.id, sessionId));

    const leaked = err instanceof SessionLaunchError && err.leakedAgent;

    // A leaked deploy left a running child; mark the run failed but
    // leave it routable (endedAt null) so the leaked child stays
    // reachable to inspect or clean up. Otherwise roll the run back
    // entirely.
    if (leaked) {
      await deps.db
        .update(workflowRun)
        .set({ status: "failed" })
        .where(eq(workflowRun.id, params.instanceId));
    } else {
      await deps.db
        .delete(workflowRun)
        .where(eq(workflowRun.id, params.instanceId));
    }

    await deps.db
      .update(principalTable)
      .set({ status: "deactivated", updatedAt: failedAt })
      .where(eq(principalTable.id, instancePrincipalId));

    throw err;
  }

  return { instancePrincipalId, sessionId };
}
