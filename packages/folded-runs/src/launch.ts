// Launches a folded interactive run — the same shape and the same
// address family `POST /workflows/runs` produces (see
// `vendor/intx/hub-api/src/routes/runs.ts`, this module's reference
// implementation — the folded-agent-instance launch route this used to
// cite, `routes/instances.ts`, was retired upstream by `b5c1525b`; the
// run-first `/workflows/runs` surface it converged onto is the same
// self-anchored-run model this module already imitates) — rather than
// the native `sessionService.deployWorkflowDefinition` path. Every
// routable run is now one self-anchored `workflow_run` row
// (`anchorRunId === id`), so a folded run and a workflow-deploy anchor
// share that shape; what still distinguishes a folded run is its
// `principalId`, whose `agent_session` join is what makes the run's
// mailbox listable through the platform's sanctioned per-run surfaces.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import type { DBExecutor } from "@intx/db";
import { buildCredentialDelivery } from "@intx/db";
import type { CredentialBinding } from "@intx/types";
import {
  agentSession,
  principal as principalTable,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { foldedRun } from "./schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import { resolveDefinitionSources } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import { InferenceSource } from "@intx/types/runtime";
import type { WireGrantRule } from "@intx/types/grant-wire";
import type { FoldedBody } from "@intx/workflow-deploy";
import {
  AGENT_RUNTIME_ENTRY_PATH,
  renderAgentRuntimeSourceTree,
  type AgentRuntimeConfig,
} from "@corbits/agent-runtime";
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
 * The `mode` a folded run's deployed definition takes. `step` is the
 * folded conversational shape every launcher gets today; `section` is
 * CL-6329's per-turn `onTrigger` shape, selected by the caller alone —
 * `deployAtHead` never branches on which one it is deploying, because
 * the mode travels inside the rendered config.
 */
export type FoldedRunMode = AgentRuntimeConfig["mode"];

/**
 * The ref a folded run's per-run workflow source tree is committed to
 * inside its definition asset. Per-run rather than the asset's default
 * branch because one definition asset backs many runs — a chat's
 * workbench host, an invited agent's every launch — and each run's tree
 * carries its OWN config in its bytes. The deploy pins the resulting
 * `commitSha`, so the ref is bookkeeping, never the pin.
 */
export function foldedRunSourceRef(instanceId: string): string {
  return `refs/heads/runs/${instanceId}`;
}

/** The rendered per-run package's own name; it never leaves the asset. */
function foldedRunPackageName(instanceId: string): string {
  return `folded-run-${instanceId}`;
}

/**
 * The mail domain a run's deployment addresses live under. The deploy
 * front re-derives `<anchorRunId>@<deploymentDomain>` and refuses a pair
 * that does not name the same run, so this must be the trigger
 * address's own domain and nothing else.
 */
function domainOfAddress(address: string): string {
  const domain = address.split("@")[1];
  if (domain === undefined || domain.length === 0) {
    throw new Error(`folded run address "${address}" carries no mail domain`);
  }
  return domain;
}

/**
 * The `workflow`-kind asset backing this run's definition — the asset
 * the launching host already minted for it (`@corbits/chat`'s
 * `launchWorkbench`, `@corbits/agent-directory`'s create route). The
 * per-run source tree is committed INTO that asset on its own ref
 * rather than into a second asset minted per deploy.
 */
async function resolveRunDefinitionAssetId(
  db: FoldedRunsDeps["db"],
  instanceId: string,
): Promise<string> {
  const row = await db
    .select({ assetId: workflowDefinition.assetId })
    .from(workflowRun)
    .innerJoin(
      workflowDefinition,
      eq(workflowDefinition.id, workflowRun.definitionId),
    )
    .where(eq(workflowRun.id, instanceId))
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined || row.assetId === null) {
    throw new Error(
      `folded run ${instanceId} has no workflow-kind definition asset to commit its per-run source tree into`,
    );
  }
  return row.assetId;
}

/**
 * The deploy-only step shared by a fresh launch (`launchFoldedRun`)
 * and a wake (re-deploying an instance the sidecar no longer has
 * resident): resolve inference sources against the tenant catalog,
 * (re)open the event collector, render the run's own workflow source
 * package, commit it, and deploy it onto the run's pre-minted anchor
 * through the adopting code-sourced front. Callers that just wrote new
 * principal/session/run rows (`launchFoldedRun`) still own their own
 * failure-path rollback of those rows — this function only throws.
 */

export async function deployAtHead(
  deps: Pick<
    FoldedRunsDeps,
    | "db"
    | "sessionService"
    | "sidecarRouter"
    | "eventCollectors"
    | "credentialCipher"
    | "assetService"
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
     * The shape the run's deployed definition takes. Defaults to the
     * folded conversational step every launcher uses today; CL-6329's
     * per-turn swap passes `{ kind: "section", turnTimeoutMs }` and
     * nothing else about this call changes, because the mode is config
     * data rendered into the deployed bytes rather than a branch here.
     */
    mode?: FoldedRunMode;
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
  // handles are one `mcp.<slug>` per tenant-connected server, unknown at
  // package-publish time), so the deploy-time capability walk never binds
  // them. Mirror `ToolGrantsForPins`'s pinned-package carve-out: when the
  // launch pins the package, fetch the tenant's real MCP credential
  // bindings and fold them in alongside whatever the definition itself
  // declares, so `env.credentials.resolve("mcp.<slug>")` has something to
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

  // The deploy front resolves the credential MATERIAL itself from the
  // deployed definition's own bindings under `credentialCipher`. What it
  // does not derive is the `credential:` use grants this run's principal
  // needs in its own `grants.json`, so the delivery is still walked here
  // — for `bindingGrants` alone.
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
  // Everything that differs per run, in one literal. The deployed
  // definition is whatever this run's own pinned bytes evaluate to, and
  // the approved wire hash covers every field below — the trigger
  // address, the system prompt, the (provider, model) pairs, the tool
  // package pins, the credential bindings — so the config cannot ride
  // beside the bytes as an env var or a staged file. It IS the bytes:
  // `renderAgentRuntimeSourceTree` writes it into the entry module the
  // approval probe and the run child each evaluate independently.
  //
  // The definition's own `credentialBindings` are what the workflow
  // host's per-step credential snapshot
  // (`vendor/intx/workflow-host/src/supervisor/credentials.ts`) derives
  // its consumer bindings from, which is why the pinned-package MCP
  // bindings folded in above have to reach the rendered config and not
  // just the delivery: without them `env.credentials.resolve("mcp.<slug>")`
  // fails "not connected" even when the material was delivered.
  const runtimeConfig: AgentRuntimeConfig = {
    workflowId: `wf_${params.instanceId}`,
    agentId: params.instanceId,
    triggerAddress: params.triggerAddress,
    systemPrompt: params.foldedBody.systemPrompt,
    inferencePreferences: resolution.sources.map((source) => ({
      provider: source.provider,
      model: source.model,
    })),
    toolPackagePins: [...params.foldedBody.toolPackagePins],
    credentialBindings,
    mode: params.mode ?? { kind: "step" },
  };
  const definitionAssetId = await resolveRunDefinitionAssetId(
    deps.db,
    params.instanceId,
  );
  const { commitSha } = await deps.assetService.populateAsset({
    assetId: definitionAssetId,
    ref: foldedRunSourceRef(params.instanceId),
    principal: { kind: "hub" },
    tree: {
      files: renderAgentRuntimeSourceTree({
        packageName: foldedRunPackageName(params.instanceId),
        config: runtimeConfig,
      }),
      message: `Deploy folded run ${params.instanceId}`,
    },
  });

  // Stage the run's step deploy tree BEFORE the deploy frame.
  //
  // This is workbench's deliberate divergence from the upstream
  // source-ref front. Upstream, a source-ref deploy stages no per-step
  // tree at all: `emitSourceRefDeployFrame` never runs
  // `executeLaunchPhases`, because the definition now travels as source
  // the child evaluates. But the sidecar's tool loader
  // (`apps/sidecar/src/step-agent-tools.ts`'s `materializeStepTools`)
  // still reads a step's pinned tool-package closure off
  // `deploy/tool-packages-manifest.json` in that tree — the prompt moved
  // into the rendered bytes, the tool manifest did not. Without this
  // call a folded run deploys with its pins in the hash and NO tools in
  // the child.
  //
  // `stageWorkflowStep` is the seam that writes exactly that tree. The
  // step address collapses to the head for a single-step deployment
  // (`resolveStepAddress`), so the run's own trigger address is the step
  // address, and the staged tree lands where the child looks for it.
  await deps.sessionService.stageWorkflowStep({
    agentAddress: params.triggerAddress,
    agentId: params.instanceId,
    runId: params.instanceId,
    config,
    deployContent: { systemPrompt: params.foldedBody.systemPrompt },
    toolPackagePins: params.foldedBody.toolPackagePins,
  });

  // The adopting front is the only code-sourced deploy a folded run can
  // use: its anchor `workflow_run` row was minted before this call
  // (`mintFoldedRun`), so the inserting front would collide on the
  // primary key, and the prepared front hard-requires an exclusive
  // allocation this run does not have.
  await deps.sessionService.deployAdoptedWorkflowFromSource({
    tenantId: params.tenantId,
    anchorRunId: params.instanceId,
    deploymentDomain: domainOfAddress(params.triggerAddress),
    agentAddress: params.triggerAddress,
    source: {
      kind: "asset",
      assetId: definitionAssetId,
      package: { format: "source", commitSha },
    },
    entry: AGENT_RUNTIME_ENTRY_PATH,
    // The run's tree lives on its own ref inside the shared definition
    // asset, so the pack the sidecar materializes has to be cut from
    // THAT ref — the asset's default ref carries a history the pinned
    // commit is not reachable from.
    sourceRef: foldedRunSourceRef(params.instanceId),
    definitionAssetId,
    config,
    ...(deps.credentialCipher !== undefined
      ? { credentialCipher: deps.credentialCipher }
      : {}),
  });

  // Produce the run's `run.grants` frame, the same contract upstream's hub
  // fires on every run birth: the sidecar writes it to
  // `runs/<runId>/grants.json` in the deployment's workflow-run repo, and
  // the supervisor's `onRunStart` barrier reads that file to authorize the
  // run. A folded run is self-anchored, so its run id IS its deployment id,
  // and `grants` — the tool-pin and credential-binding set already deployed
  // as `config.grants` — is the run's whole grant set.
  //
  // Sent after the deploy resolves and before any trigger mail: the sidecar
  // registers its grants handler during the deploy the ack acknowledges, and
  // both frames ride the same per-address channel, so same-socket FIFO puts
  // the grants on disk ahead of the mail that starts the run.
  if (
    !deps.sidecarRouter.sendRunGrants(
      params.triggerAddress,
      params.instanceId,
      grants,
    )
  ) {
    throw new Error(
      `${params.launchLabel}: deployment ${params.triggerAddress} is not routable for run ${params.instanceId}; cannot deliver its run grants, so the run would start under-authorized`,
    );
  }
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
  mode?: FoldedRunMode;
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

export type MintFoldedRunParams = Pick<
  LaunchFoldedRunParams,
  "tenantId" | "instanceId" | "triggerAddress" | "definitionId" | "persistExtra"
>;

/**
 * The mint half of a folded-run launch: one transaction writing the
 * run's principal/session/run rows (plus the caller's `persistExtra`),
 * touching no sidecar and deploying nothing. A run minted this way is
 * fully addressable — `sendMail`'s wake choke point deploys it from
 * the caller's persisted launch body on its first traffic — so a
 * caller that wants a snappy, DB-only mint (chat creation) uses this
 * directly, while a caller whose run must be executing the moment the
 * call returns (tasks, routines) stays on `launchFoldedRun` below.
 */
export async function mintFoldedRun(
  deps: Pick<FoldedRunsDeps, "db">,
  params: MintFoldedRunParams,
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

  return { instancePrincipalId, sessionId };
}

/**
 * The launch core shared by a task run and a routine occurrence alike
 * (or any other folded-run launch a host composes): mint via
 * `mintFoldedRun`, then resolve inference sources against the tenant
 * catalog, open the event collector, and deploy via
 * `deployInstanceAtHead` — with the same failure-path cleanup a deploy
 * failure needs. Only how the launch body (`foldedBody`) and the
 * instance's identity (`instanceId`/`triggerAddress`/`definitionId`)
 * are sourced is the caller's concern.
 */
export async function launchFoldedRun(
  deps: FoldedRunsDeps,
  params: LaunchFoldedRunParams,
): Promise<LaunchedFoldedRun> {
  const { instancePrincipalId, sessionId } = await mintFoldedRun(deps, {
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    triggerAddress: params.triggerAddress,
    definitionId: params.definitionId,
    ...(params.persistExtra !== undefined
      ? { persistExtra: params.persistExtra }
      : {}),
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
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
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
