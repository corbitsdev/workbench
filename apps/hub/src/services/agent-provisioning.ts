import { eq, and, inArray, like } from "drizzle-orm";
import { schema as intxSchema, resolveModelSources } from "@intx/db";
import type { DB } from "@intx/db";
import {
  ModelRequirements,
  InvokerModelPreferences,
  type ProviderPreference,
} from "@intx/types";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type {
  SessionService,
  SidecarRouter,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import { composePersonalAgentPromptForInstance } from "../lib/operator-profile";
import {
  buildToolDefinitions,
  getToolNamesFromCapabilities,
} from "../lib/tool-registry";
import { parseAgentRow } from "@intx/db";
import {
  buildToolGrantRows,
  TOOL_GRANT_RESOURCE_PREFIX,
} from "../lib/tool-grants";

const log = getLogger(["api", "agents"]);

const { agent, agentInstance, agentSession, grant, tenant } = intxSchema;

export const LAUNCH_RETRY_DELAY_MS = 1_000;
export const MAX_LAUNCH_ATTEMPTS = 3;

/**
 * Resolve an instance's inference sources from its agent *definition's* model
 * requirements against the *instance's* tenant catalog, walking the ancestor
 * chain for offerings and credentials.
 *
 * The definition may live in an ancestor tenant — a child-tenant instance of a
 * shared parent definition (e.g. a workbench instance of a global-org agent).
 * The tenant-exact `resolveInstanceModelSources` re-looks-up the agent scoped
 * to the resolving tenant, so it cannot see an ancestor-owned definition and
 * reports `no_requirements`. We instead resolve from the requirements on the
 * already-fetched definition row, anchoring catalog + credential resolution at
 * the instance tenant so descendant-local credentials shadow inherited ones.
 * Mirrors Interchange's native instances route.
 */
export async function resolveInstanceSourcesFromDefinition(
  db: DB["db"],
  tenantId: string,
  agentRow: typeof agent.$inferSelect,
  modelPreferences: unknown,
) {
  const modelRequirements =
    agentRow.modelRequirements !== null
      ? ModelRequirements.assert(agentRow.modelRequirements)
      : [];
  const invokerPreferences: Record<string, ProviderPreference> = {};
  const preferences =
    modelPreferences !== null && modelPreferences !== undefined
      ? InvokerModelPreferences.assert(modelPreferences)
      : [];
  for (const preference of preferences) {
    invokerPreferences[preference.model] = preference.providers;
  }
  return resolveModelSources(db, tenantId, modelRequirements, {
    invokerPreferences,
  });
}

/**
 * Reconcile the persisted `tool:*` grant rows for an instance principal to the
 * given tool set. Deletes the principal's existing system tool grants and
 * re-inserts the current set, so `collectGrants` returns them at launch AND on
 * the orchestrator's reconnect path. Idempotent; safe to call on every launch.
 */
export async function persistInstanceToolGrants(
  db: DB["db"],
  opts: {
    tenantId: string;
    principalId: string;
    toolNames: string[];
    now: Date;
  },
): Promise<void> {
  const { tenantId, principalId, toolNames, now } = opts;
  const rows = buildToolGrantRows(toolNames, { tenantId, principalId }, now);
  await db.transaction(async (tx) => {
    await tx
      .delete(grant)
      .where(
        and(
          eq(grant.principalId, principalId),
          eq(grant.origin, "system"),
          like(grant.resource, `${TOOL_GRANT_RESOURCE_PREFIX}%`),
        ),
      );
    if (rows.length > 0) {
      await tx.insert(grant).values(rows);
    }
  });
}

export type GrantRequirementRow = {
  source: "tenant" | "creator" | "invoker";
  resource: string;
  action: string;
  effect?: "allow" | "deny";
  conditions?: Record<string, unknown> | null;
};

/**
 * Materialize an agent definition's `grantRequirements` onto its instance
 * principal so `collectGrants` returns them in the launch deploy frame. Mirrors
 * Interchange's native deploy route (hub-api instances.ts), which resolves and
 * writes these rows before launch. The dynamic per-tenant deliver grant
 * (`tenant:<tenantId>` / `deliver`) — dropped from the seeded definition because
 * it depends on the launch-time tenant — is added here so mail delivery is
 * authorized. Idempotent: clears prior requirement-origin grants for the
 * principal and re-inserts, so launch and reconnect agree.
 */
export async function persistInstanceGrantRequirements(
  db: DB["db"],
  opts: {
    tenantId: string;
    principalId: string;
    grantRequirements: GrantRequirementRow[];
    now: Date;
  },
): Promise<void> {
  const { tenantId, principalId, grantRequirements, now } = opts;

  const rows = grantRequirements.map((req) => ({
    id: generateId("grant"),
    tenantId,
    principalId,
    resource: req.resource,
    action: req.action,
    effect: req.effect ?? ("allow" as const),
    conditions: req.conditions ?? null,
    origin:
      req.source === "creator" ? ("creator" as const) : ("invoker" as const),
    createdAt: now,
    updatedAt: now,
  }));

  // The dynamic per-tenant deliver grant, computed at launch (not seeded).
  rows.push({
    id: generateId("grant"),
    tenantId,
    principalId,
    resource: `tenant:${tenantId}`,
    action: "deliver",
    effect: "allow" as const,
    conditions: null,
    origin: "invoker" as const,
    createdAt: now,
    updatedAt: now,
  });

  await db.transaction(async (tx) => {
    await tx
      .delete(grant)
      .where(
        and(
          eq(grant.principalId, principalId),
          inArray(grant.origin, ["creator", "invoker"]),
        ),
      );
    if (rows.length > 0) {
      await tx.insert(grant).values(rows);
    }
  });
}

export async function launchAgentSession(
  db: DB["db"],
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  opts: {
    agentId: string;
    instanceId: string;
    instancePrincipalId: string;
    tenantId: string;
    tenantDomain: string;
    systemPrompt: string;
    now: Date;
  },
): Promise<{ address: string; sessionId: string }> {
  const {
    agentId,
    instanceId,
    instancePrincipalId,
    tenantId,
    tenantDomain,
    systemPrompt,
    now,
  } = opts;
  const address = `${instanceId}@${tenantDomain}`;

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, agentId),
  });
  if (!agentRow) throw new Error(`Agent not found: ${agentId}`);

  // Resolve from the instance's persisted invoker preferences so launch,
  // reconnect, and the /me credential check reproduce the same source ordering
  // (the resolution contract is a pure function of persisted instance state).
  const instanceRow = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });

  const resolution = await resolveInstanceSourcesFromDefinition(
    db,
    tenantId,
    agentRow,
    instanceRow?.modelPreferences ?? null,
  );
  if (!resolution.ok) {
    const reason =
      resolution.reason === "model_unavailable"
        ? `model_unavailable (${resolution.model})`
        : resolution.reason;
    throw new Error(
      "No resolvable inference sources for agent credential requirements: " +
        reason,
    );
  }

  const sources = resolution.sources;
  const defaultSource = sources[0]!.id;

  const toolNames = getToolNamesFromCapabilities(agentRow.capabilities ?? null);
  const tools = buildToolDefinitions(toolNames);

  // Personalize the personal agent per instance: rebuild its prompt in the
  // provider-appropriate format (Markdown for openai-compatible, XML for
  // Anthropic) and append the owning operator's profile. Identity is the
  // structural personal-template marker, not the display name. Best-effort —
  // a non-personal instance or an unresolved operator keeps the seeded prompt,
  // never a launch failure.
  const defaultSourceProvider =
    sources.find((s) => s.id === defaultSource)?.provider ??
    sources[0]!.provider;
  let effectiveSystemPrompt = systemPrompt;
  try {
    const personalized = await composePersonalAgentPromptForInstance(db, {
      tenantId,
      instanceId,
      provider: defaultSourceProvider,
    });
    if (personalized !== null) {
      effectiveSystemPrompt = personalized;
    }
  } catch (err) {
    log.warn(
      "Failed to personalize personal-agent prompt; using seeded prompt",
      {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Persist the agent's tool grants on the instance principal before collecting.
  // Tool authorization is trust-by-configuration (any configured tool is allowed,
  // origin 'system'). These rows MUST be persisted, not synthesized in memory:
  // the orchestrator's reconnect path re-sends only what collectGrants reads from
  // the DB, so in-memory tool grants were silently dropped on every sidecar
  // reconnect (CL-1398). Persisting makes launch and reconnect agree.
  await persistInstanceToolGrants(db, {
    tenantId,
    principalId: instancePrincipalId,
    toolNames,
    now,
  });

  // Materialize the agent definition's grant requirements onto the instance
  // principal — the same step Interchange's native deploy route performs
  // (hub-api instances.ts grant-requirement resolution). Without this, the
  // collectGrants snapshot below is missing capabilities the agent declares it
  // needs (e.g. Myra's tool:mail_send/invoke and the per-tenant deliver grant),
  // so mail delivery failed with sidecar_unavailable. These are our own seeded,
  // trusted definitions deployed through an authenticated route, so we
  // materialize the declared requirements directly rather than re-running the
  // creator/invoker delegation check.
  await persistInstanceGrantRequirements(db, {
    tenantId,
    principalId: instancePrincipalId,
    grantRequirements: (agentRow.grantRequirements ??
      []) as GrantRequirementRow[],
    now,
  });

  const grants = await grantStore.collectGrants(instancePrincipalId, tenantId);

  // Resolve the session to launch under. Reuse the instance's existing active
  // session (resume) rather than minting a new one on every call. Minting
  // unconditionally caused session churn (CL-1651): a transient sidecar
  // disconnect made the instance briefly unroutable, so every POST /v1/me sync poll
  // slipped past the routable guard in relaunchInstanceIfNeeded and created a
  // fresh session, orphaning the prior one and dropping in-flight live events
  // whose turns belonged to the superseded session.
  const existing = instanceRow;
  let sessionId: string | undefined;
  if (existing?.sessionId) {
    const existingSession = await db.query.agentSession.findFirst({
      where: eq(agentSession.id, existing.sessionId),
    });
    // Reusing existing.sessionId is only sound because the instance already
    // points at it — we resume in place rather than repointing the instance at a
    // different active session. The skipped agentInstance.update below relies on
    // that invariant.
    if (existingSession?.status === "active") {
      sessionId = existing.sessionId;
    }
  }
  if (sessionId === undefined) {
    sessionId = generateId("session");
    await db.insert(agentSession).values({
      id: sessionId,
      tenantId,
      agentId,
      principalId: instancePrincipalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(agentInstance)
      .set({ sessionId, updatedAt: now })
      .where(eq(agentInstance.id, instanceId));
  }

  const launchConfig = {
    agentAddress: address,
    agentId,
    instanceId,
    config: {
      sessionId,
      agentId,
      tenantId,
      principalId: instancePrincipalId,
      agentAddress: address,
      systemPrompt: effectiveSystemPrompt,
      tools,
      grants,
      sources,
      defaultSource,
    },
    deployContent: { systemPrompt: effectiveSystemPrompt },
    // Hub-proxy tools (config.tools) and native tool packages (toolPackagePins)
    // coexist during migration: each tool that moves to a package must be removed
    // from buildToolDefinitions in the same change as adding the package pin.
    // Guard against null: the column is NOT NULL DEFAULT [] but rows seeded before
    // migration 0029 may carry null in legacy deployments.
    toolPackagePins:
      agentRow.toolPackages != null ? parseAgentRow(agentRow).toolPackages : [],
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt++) {
    try {
      await sessionService.launchSession(launchConfig);
      // Register the event collector before updating status so inference events
      // arriving immediately after launch are captured rather than dropped.
      eventCollectors.create(address, tenantId, sessionId, instanceId);
      await db
        .update(agentInstance)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agentInstance.id, instanceId));
      log.info("Agent session launched", { instanceId, agentId, tenantId });
      return { address, sessionId };
    } catch (err) {
      lastError = err;
      // Provision-phase failures mean the sidecar already has the agent or
      // rejected the config. Neither condition improves with retries.
      if (err instanceof SessionLaunchError && err.phase === "provision") break;
      if (attempt < MAX_LAUNCH_ATTEMPTS - 1) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, LAUNCH_RETRY_DELAY_MS),
        );
      }
    }
  }

  // Launch ultimately failed — mark the session ended. Stamp endedAt (not just
  // status) so ended sessions carry a timestamp (CL-1651).
  const failedAt = new Date();
  await db
    .update(agentSession)
    .set({ status: "ended", endedAt: failedAt, updatedAt: failedAt })
    .where(
      and(eq(agentSession.id, sessionId), eq(agentSession.status, "active")),
    );

  // Clean up any tool grants written before the launch loop — they're orphaned
  // since no session launched, and would otherwise be returned by collectGrants
  // on the next reconnect attempt with incorrect scope.
  await db
    .delete(grant)
    .where(
      and(
        eq(grant.principalId, instancePrincipalId),
        eq(grant.origin, "system"),
        like(grant.resource, `${TOOL_GRANT_RESOURCE_PREFIX}%`),
      ),
    );

  throw lastError;
}

// Relaunch a Myra instance's session if it has no active session but has credentials granted.
// Called from POST /v1/me so existing users get Myra running automatically on login.
export async function relaunchInstanceIfNeeded(
  db: DB["db"],
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  instanceId: string,
  sidecarRouter: SidecarRouter,
): Promise<void> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });
  if (!instance) return;

  // A stopped instance with endedAt set was explicitly deleted — it cannot be
  // relaunched.
  if (instance.status === "stopped" && instance.endedAt !== null) return;

  // The sidecar — not the hub — owns the lifecycle of a launched agent. If the
  // address is routable on a connected sidecar the agent is live; and even while
  // momentarily unroutable during a sidecar reconnect, an instance that already
  // has an active session is restored by the sidecar (see the agent.reconnected
  // path in hub-session-orchestrator). Relaunching from the poll-driven POST /v1/me
  // path in either case churns sessions and can evict the live agent ("Agent
  // already exists" → router eviction → 502). So relaunch only for a genuine cold
  // start: an instance with no active session yet. (CL-1651)
  if (sidecarRouter.getRoutableAddresses().includes(instance.address)) return;
  if (instance.sessionId) {
    const session = await db.query.agentSession.findFirst({
      where: eq(agentSession.id, instance.sessionId),
    });
    // Active or ending: the harness owns it (live, or mid-teardown). Only a fully
    // ended session leaves nothing for the harness to resume — relaunching while
    // a session is 'ending' would mint a fresh one mid-teardown and re-churn.
    if (session && session.status !== "ended") return;
  }

  const tenantRow = await db.query.tenant.findFirst({
    where: eq(tenant.id, instance.tenantId),
  });
  if (!tenantRow?.domain) return;

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, instance.agentId),
  });
  if (!agentRow?.systemPrompt) return;

  // Guard: do not attempt launch if the agent's model requirements cannot
  // resolve against the tenant catalog. Without this, every POST /v1/me sync for
  // a tenant whose catalog is not yet seeded fires a launch that always fails
  // with `no_requirements`. This is the same resolution launchAgentSession runs,
  // so the guard and the launch agree by construction.
  const guardResolution = await resolveInstanceSourcesFromDefinition(
    db,
    instance.tenantId,
    agentRow,
    instance.modelPreferences,
  );
  if (!guardResolution.ok) return;

  try {
    await launchAgentSession(db, sessionService, grantStore, eventCollectors, {
      agentId: instance.agentId,
      instanceId: instance.id,
      instancePrincipalId: instance.principalId,
      tenantId: instance.tenantId,
      tenantDomain: tenantRow.domain,
      systemPrompt: agentRow.systemPrompt,
      now: new Date(),
    });
  } catch (err) {
    // Agent already running on the sidecar — nothing to do.
    if (isAgentAlreadyExistsError(err)) return;
    throw err;
  }
}

/**
 * Structured description of a failed launch for the HTTP layer. `phase` is the
 * SessionLaunchError phase ("write" | "provision" | "pack" | "start") when the
 * failure carries one; `detail` is the underlying cause message (which the
 * tool-package loader and harness already stamp with the offending package /
 * provider name), so the response names the failing tool package wherever the
 * sidecar surfaced it.
 */
export type LaunchErrorDescription = {
  phase: string | null;
  detail: string;
};

export function describeLaunchError(err: unknown): LaunchErrorDescription {
  if (err instanceof SessionLaunchError) {
    const cause = err.cause;
    const detail = cause instanceof Error ? cause.message : err.message;
    return { phase: err.phase, detail };
  }
  if (err instanceof Error) {
    return { phase: null, detail: err.message };
  }
  return { phase: null, detail: String(err) };
}

/**
 * Returns true when the error indicates the sidecar already has the agent
 * provisioned. This can happen in a race between the orchestrator's reconnect
 * path and an explicit launch call — the agent is live and the caller should
 * treat the situation as success.
 */
export function isAgentAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("Agent already exists for address");
}

// A sidecar that fully restarts (every redeploy) reconnects with no agents, so
// the address it previously routed never re-registers. Interchange's
// orchestrator only abandons the event collector on sidecar.disconnect and
// leaves agent_session.status = 'active' so a transient reconnect can resume.
// When the reconnect never comes, the DB is left describing a live agent that
// no sidecar routes — and relaunchInstanceIfNeeded then returns early forever
// (active session ⇒ "harness owns it"), wedging the instance until its row is
// deleted by hand. The grace window is the host's bet on how long a genuine
// reconnect can take; past it, an address that is still unroutable is gone.
const DEFAULT_DISCONNECT_RECONCILE_GRACE_MS = 90_000;

/**
 * Reconciles one disconnected agent address against sidecar reality. If the
 * address is routable again the sidecar reconnected and there is nothing to do.
 * Otherwise the agent is gone, so any non-ended session is marked ended — which
 * lets the next relaunchInstanceIfNeeded treat the instance as a cold start and
 * bring it back, instead of mistaking the stale session for a live agent. (CL-1692)
 */
export async function reconcileDisconnectedSession(
  db: DB["db"],
  sidecarRouter: SidecarRouter,
  agentAddress: string,
): Promise<void> {
  if (sidecarRouter.getRoutableAddresses().includes(agentAddress)) return;

  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.address, agentAddress),
  });
  if (!instance?.sessionId) return;

  const session = await db.query.agentSession.findFirst({
    where: eq(agentSession.id, instance.sessionId),
  });
  if (!session || session.status === "ended") return;

  const now = new Date();
  await db
    .update(agentSession)
    .set({ status: "ended", endedAt: now, updatedAt: now })
    .where(eq(agentSession.id, session.id));

  log.info("Reconciled stale session for disconnected agent", {
    agentAddress,
    sessionId: session.id,
  });
}

/**
 * Subscribes to sidecar disconnects and, after a grace window, reconciles any
 * address that did not reconnect. Returns an unsubscribe function. The grace
 * window lets a genuine reconnect win the race before we tear the session down.
 */
export function registerDisconnectReconciler(deps: {
  db: DB["db"];
  router: SidecarRouter;
  graceMs?: number;
}): () => void {
  const { db, router } = deps;
  const graceMs = deps.graceMs ?? DEFAULT_DISCONNECT_RECONCILE_GRACE_MS;

  return router.events.on("sidecar.disconnect", ({ agentAddresses }) => {
    for (const agentAddress of agentAddresses) {
      setTimeout(() => {
        void reconcileDisconnectedSession(db, router, agentAddress).catch(
          (err) => {
            log.warn("Failed to reconcile disconnected agent session", {
              agentAddress,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          },
        );
      }, graceMs);
    }
  });
}
