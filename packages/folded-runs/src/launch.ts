// Launches a folded interactive run — the same shape and the same
// address family `POST /workflows/runs` produces (see
// `vendor/intx/hub-api/src/routes/runs.ts`, this module's reference
// implementation — the folded-agent-instance launch route this used to
// cite, `routes/instances.ts`, was retired upstream by `b5c1525b`; the
// run-first `/workflows/runs` surface it converged onto is the same
// self-anchored-run model this module already imitates) — rather than
// the native
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
import { buildCredentialDelivery } from "@intx/db";
import type { CredentialBinding } from "@intx/types";
import {
  agentSession,
  principal as principalTable,
  workflowRun,
} from "@intx/db/schema";
import { foldedRun } from "./schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import { resolveDefinitionSources } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import { InferenceSource } from "@intx/types/runtime";
import type { WireGrantRule } from "@intx/types/grant-wire";
import {
  wrapHarnessAsSingleStepWorkflow,
  type FoldedBody,
} from "@intx/workflow-deploy";
import { defineWorkflow, step, type Selector } from "@intx/workflow";
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
 * anchor never runs a real inference turn — a workbench host's noop
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
const FOLDED_STEP_ID = "default";

export async function deployAtHead(
  deps: Pick<
    FoldedRunsDeps,
    | "db"
    | "sessionService"
    | "eventCollectors"
    | "credentialCipher"
    | "hubPublicKey"
    | "toolGrantsForPins"
    | "mcpCredentialBindingsFor"
  >,
  params: {
    tenantId: string;
    instanceId: string;
    triggerAddress: string;
    principalId: string;
    sessionId: string;
    foldedBody: FoldedBody;
    /** Named in the "seed a tenant catalog source" error, e.g. "the workbench host", "the invited agent", or "the woken instance". */
    launchLabel: string;
    /**
     * When present, used verbatim in place of `resolveDefinitionSources`
     * — the tenant catalog is never touched, so a launch pinned this
     * way needs no catalog source to exist at all. Absent, this is
     * the ordinary catalog-resolved path every launch used before this
     * override existed.
     */
    sources?: SourcesOverride;
    /**
     * The model to resolve against when `foldedBody.model` is `null` —
     * a definition that declares no model requirements of its own
     * (e.g. a hand-authored agent created without a `model`). Absent,
     * a `null` `foldedBody.model` resolves to the loud
     * `InferenceResolutionError` it always has; present, it is what
     * lets that same definition still launch by falling back to the
     * caller's own tenant-default resolution instead of 409ing. Never
     * consulted when `foldedBody.model` is already set.
     */
    fallbackModel?: string;
    /**
     * Overrides the step's default input selector (`{ from:
     * "trigger.payload" }`, `defineWorkflow`'s standard first-step
     * default). The default reads the triggering mail's bare `content`
     * verbatim and feeds it straight into `agent.send`, which throws on
     * an empty string — and `content` is legitimately empty for
     * attachments-only mail (an event-only send, e.g.
     * `workbench.agent-joined`; see `@corbits/chat`'s `encodeParts`).
     * A folded run that genuinely ignores its input (the workbench host:
     * its system prompt forbids ever acting on what it receives) should
     * pin a `{ literal: ... }` selector here instead of reading
     * `trigger.payload`, so an attachments-only mail landing in its
     * inbox — its very first message, in the common case — cannot crash
     * the run before it ever opens (CL-6164). Absent, behavior is
     * unchanged: the step reads the real trigger payload, as every
     * inference-driven agent must.
     */
    stepInput?: Selector;
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
          fallbackModel:
            params.foldedBody.model ?? params.fallbackModel ?? null,
          invokerPreferences: {},
          ...(deps.credentialCipher !== undefined
            ? { credentialCipher: deps.credentialCipher }
            : {}),
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

  // Every pinned tool package's `tool:<qualifiedId>` grant, minted
  // against this run's own principal so the child's authz gate
  // (`vendor/intx/inference/src/authz-extension.ts`) has a matching
  // grant for every call the pinned package can make. See
  // `ToolGrantsForPins`'s doc for why this has to happen here rather
  // than relying on the deploy-time capability walk.
  const grants: WireGrantRule[] = deps
    .toolGrantsForPins(params.foldedBody.toolPackagePins)
    .map((declaration) => ({
      id: generateId("grant"),
      resource: declaration.resource,
      action: declaration.action,
      effect: declaration.effect,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId: params.principalId,
    }));

  // `@corbits/mcp-tools` declares no static `interchange.credentials` (its
  // handles are one `mcp:<slug>` per tenant-connected server, unknown at
  // package-publish time), so the deploy-time capability walk never binds
  // them. Mirror `ToolGrantsForPins`'s pinned-package carve-out: when the
  // launch pins the package, fetch the tenant's real MCP credential
  // bindings and fold them in alongside whatever the definition itself
  // declares, so `env.credentials.resolve("mcp:<slug>")` has something to
  // find instead of failing every call closed with "not connected".
  const isMcpToolsPin = params.foldedBody.toolPackagePins.some(
    (pin) => pin.name === "@corbits/mcp-tools",
  );
  const mcpBindings: readonly CredentialBinding[] =
    isMcpToolsPin && deps.mcpCredentialBindingsFor !== undefined
      ? await deps.mcpCredentialBindingsFor(params.tenantId)
      : [];
  const credentialBindings = [
    ...params.foldedBody.credentialBindings,
    ...mcpBindings,
  ];

  let credentials: Parameters<
    FoldedRunsDeps["sessionService"]["deploySingleStepAtHead"]
  >[0]["credentials"];
  if (credentialBindings.length > 0) {
    if (deps.credentialCipher === undefined) {
      throw new Error(
        `${params.launchLabel}: launch carries credential bindings but no credentialCipher was supplied; cannot resolve credential material`,
      );
    }
    const delivery = await buildCredentialDelivery({
      db: deps.db,
      tenantId: params.tenantId,
      bindings: credentialBindings,
      creatorPrincipalId: null,
      invokerPrincipalId: params.principalId,
      credentialCipher: deps.credentialCipher,
    });
    if (!delivery.ok) {
      throw new Error(
        `${params.launchLabel}: credential binding resolution failed: ${delivery.reason.message}`,
      );
    }
    credentials = delivery.delivery;
    for (const bindingGrant of delivery.bindingGrants) {
      grants.push({
        id: generateId("grant"),
        resource: bindingGrant.resource,
        action: "use",
        effect: "allow",
        origin: "system",
        conditions: bindingGrant.conditions,
        expiresAt: null,
        roleId: null,
        principalId: params.principalId,
      });
    }
  }

  const config = {
    sessionId: params.sessionId,
    agentId: params.instanceId,
    tenantId: params.tenantId,
    principalId: params.principalId,
    agentAddress: params.triggerAddress,
    systemPrompt: params.foldedBody.systemPrompt,
    tools: [],
    grants,
    sources: resolution.sources,
    defaultSource: resolution.defaultSource,
  };
  const deployContent = { systemPrompt: params.foldedBody.systemPrompt };
  // A folded run is a conversation: its one step must service every
  // inbound mail as another turn, never complete after the first. The
  // platform's `deployInstanceAtHead` wraps the agent as a step with the
  // default trigger budget of 1 (batch), which is exactly what made every
  // chat go silent after its first real reply — so the folded launch
  // builds the same single-step workflow itself, with the budget
  // declared, and deploys it through the same head deploy.
  const foldedSteps = {
    [FOLDED_STEP_ID]: step({
      agent: wrapHarnessAsSingleStepWorkflow({ config, deployContent }),
      triggers: "unbounded",
      ...(params.stepInput !== undefined ? { input: params.stepInput } : {}),
    }),
  };
  // The workflow-host's per-step credential snapshot
  // (`vendor/intx/workflow-host/src/supervisor/credentials.ts`) derives
  // its bindings from the deployed *definition*'s own
  // `credentialBindings`, not from `buildCredentialDelivery`'s output —
  // that delivery only seeds the credential material itself. Mirror
  // `buildAgentDefinitionWorkflow`'s same conditional shape so a folded
  // run's synthesized definition carries the same combined bindings
  // (the definition's own plus the pinned-package MCP bindings folded in
  // above) the delivered material was resolved against; without this the
  // sidecar's `consumerBindings` finds nothing for `mcp:<slug>` and every
  // resolve() fails "not connected" even though the material was
  // delivered.
  const definition =
    credentialBindings.length > 0
      ? defineWorkflow({
          id: `wf_${params.instanceId}`,
          trigger: { type: "mail", to: params.triggerAddress },
          credentialBindings,
          steps: foldedSteps,
        })
      : defineWorkflow({
          id: `wf_${params.instanceId}`,
          trigger: { type: "mail", to: params.triggerAddress },
          steps: foldedSteps,
        });
  await deps.sessionService.deploySingleStepAtHead({
    agentAddress: params.triggerAddress,
    agentId: params.instanceId,
    runId: params.instanceId,
    config,
    deployContent,
    definition,
    sources: { [FOLDED_STEP_ID]: resolution.sources },
    hubPublicKey: deps.hubPublicKey,
    toolPackagePins: params.foldedBody.toolPackagePins,
    ...(credentials !== undefined ? { credentials } : {}),
  });
}

export type LaunchFoldedRunParams = {
  tenantId: string;
  instanceId: string;
  triggerAddress: string;
  definitionId: string;
  foldedBody: FoldedBody;
  /** Named in the "seed a tenant catalog source" error, e.g. "the workbench host" or "the invited agent". */
  launchLabel: string;
  /**
   * When present, used verbatim in place of catalog resolution — see
   * `deployAtHead`'s own doc on the same field.
   */
  sources?: SourcesOverride;
  /** See `deployAtHead`'s own doc on the same field. */
  fallbackModel?: string;
  /** See `deployAtHead`'s own doc on the same field. */
  stepInput?: Selector;
  /**
   * Invoked inside the same launch transaction, immediately after the
   * principal/session/run rows are written, so a caller-owned table
   * (e.g. `@corbits/chat`'s `workbench_launch`) commits atomically with
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
 * The launch core shared by a workbench host and an invited agent alike
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

    // The folded run IS the launched instance, so its own id is a
    // valid, vendor-native "deployed" anchor — the same shape
    // `workflow-allocation-service.ts`'s deploy path mints
    // (`anchorRunId: args.anchorRunId`, its own id). A null anchor was
    // the prior design, but `hub-session-lookups.ts`'s
    // `receiveWorkflowRunPack` requires the live run at the source
    // address to satisfy `anchorRunId === id` before it will accept a
    // workflow-run mail pack; a null anchor never satisfies that, so
    // every chat agent's pack was permanently rejected. Self-anchoring
    // satisfies the check. [Intx gap] CL-6044: vendor's
    // `receiveWorkflowRunPack` has no concept of a self-anchored run
    // that isn't also a top-level deployment, so workbench's
    // folded-run family must mimic the deployment anchor shape exactly
    // to be accepted; tracked upstream, do not attempt to fix vendor
    // here.
    //
    // Self-anchoring also takes this run out of reach of vendor's
    // push-based credential rotation (`credential-push.ts` only
    // targets `anchorRunId IS NULL` rows), but folded runs never
    // depended on that push: `deployAtHead` re-resolves inference
    // sources fresh from the tenant catalog (or a caller-pinned
    // `SourcesOverride`) on every launch and every wake, so rotation
    // already happens at redeploy time regardless of the push.
    await tx.insert(workflowRun).values({
      id: params.instanceId,
      definitionId: params.definitionId,
      anchorRunId: params.instanceId,
      tenantId: params.tenantId,
      principalId: instancePrincipalId,
      address: params.triggerAddress,
      status: "running",
      modelPreferences: null,
      createdAt: now,
    });

    // Permanently marks this run as folded, in `folded-runs`'s own
    // package-owned table — see `./schema.ts`'s doc comment for why
    // this has to be written here, unconditionally, rather than left
    // to each caller's own `persistExtra`: it is the one thing every
    // folded run needs recorded, and the workbench-owned scoped run
    // listings (e.g. the hub's `/top-level-runs` route) depend on it
    // existing for every run this function launches, with zero
    // per-caller opt-in.
    await tx.insert(foldedRun).values({
      id: params.instanceId,
      tenantId: params.tenantId,
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
    const deployAtHeadParams = {
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      triggerAddress: params.triggerAddress,
      principalId: instancePrincipalId,
      sessionId,
      foldedBody: params.foldedBody,
      launchLabel: params.launchLabel,
    };
    await deployAtHead(deps, {
      ...deployAtHeadParams,
      ...(params.sources !== undefined ? { sources: params.sources } : {}),
      ...(params.fallbackModel !== undefined
        ? { fallbackModel: params.fallbackModel }
        : {}),
      ...(params.stepInput !== undefined
        ? { stepInput: params.stepInput }
        : {}),
    });
  } catch (err) {
    // Mirrors the reference route's failure-path cleanup: a deploy
    // failure must not leave the just-committed principal/session/run
    // rows behind as a permanently "running" ghost that nothing is
    // listening on.
    deps.eventCollectors.abandon(params.triggerAddress);

    const failedAt = new Date();
    const leaked = err instanceof SessionLaunchError && err.leakedAgent;

    await deps.db.transaction(async (tx) => {
      await tx
        .update(agentSession)
        .set({ status: "ended", endedAt: failedAt, updatedAt: failedAt })
        .where(eq(agentSession.id, sessionId));

      // A leaked deploy left a running child; mark the run failed but
      // leave it routable (endedAt null) so the leaked child stays
      // reachable to inspect or clean up. Otherwise roll the run back
      // entirely.
      if (leaked) {
        await tx
          .update(workflowRun)
          .set({ status: "failed" })
          .where(eq(workflowRun.id, params.instanceId));
      } else {
        await tx
          .delete(workflowRun)
          .where(eq(workflowRun.id, params.instanceId));
        await tx.delete(foldedRun).where(eq(foldedRun.id, params.instanceId));
      }

      await tx
        .update(principalTable)
        .set({ status: "deactivated", updatedAt: failedAt })
        .where(eq(principalTable.id, instancePrincipalId));
    });

    throw err;
  }

  return { instancePrincipalId, sessionId };
}
