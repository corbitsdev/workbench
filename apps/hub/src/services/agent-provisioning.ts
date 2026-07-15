import { createHash } from "node:crypto";
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
import {
  appendPageContextToPrompt,
  normalizePageContextInput,
} from "../lib/page-context";
import { composePersonalAgentPromptForInstance } from "../lib/operator-profile";
import { PERSONAL_AGENT_PROMPT_VERSION } from "@workbench/myra";
import {
  buildToolDefinitions,
  getToolNamesFromCapabilities,
} from "../lib/tool-registry";
import { parseAgentRow } from "@intx/db";
import {
  buildToolGrantRows,
  TOOL_GRANT_RESOURCE_PREFIX,
} from "../lib/tool-grants";
import { runDedupedRelaunch } from "./relaunch-breaker";
import { getCachedCatalogSources } from "./workflow-model-source-cache";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";

const log = getLogger(["api", "agents"]);

const { agent, agentInstance, agentSession, grant, tenant, sessionAsset } =
  intxSchema;

// Kept short and paired with the client's own adaptive reconnect backoff
// (use-myra-session.ts RECONNECT_FIRST_DELAY_MS): a slow retry loop here would
// stack with the client's retry rather than resolve within one connect cycle.
export const LAUNCH_RETRY_DELAY_MS = 500;
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

type InstanceSourceResolution = Awaited<
  ReturnType<typeof resolveInstanceSourcesFromDefinition>
>;

// Sentinel so a failed resolution propagates OUT of the cache thunk without
// being memoized — caching an "unavailable" for the TTL would strand launches
// after a transient catalog gap heals.
class UnresolvedInstanceSourcesError extends Error {
  constructor(
    readonly resolution: Extract<InstanceSourceResolution, { ok: false }>,
  ) {
    super("unresolved instance sources");
    this.name = "UnresolvedInstanceSourcesError";
  }
}

/**
 * Cached wrapper over `resolveInstanceSourcesFromDefinition` for the launch hot
 * path (CL-2804). Reuses the workflow deploy catalog cache (CL-2760): a short
 * per-(tenant, requirement-set) TTL memo, so a burst of launches for the same
 * agent definition — e.g. a member spamming "+ New chat" — collapses onto one
 * catalog resolution instead of re-hitting the DB every time.
 *
 * Correctness:
 *   - Instances carrying invoker model preferences BYPASS the shared cache: the
 *     preference-free key would return the wrong source ordering.
 *   - `keyExtra` fingerprints the full model requirements (capabilities +
 *     creator provider preferences), not just model names, so two definitions
 *     requiring the same model with different capabilities never collide.
 *   - Resolution is a pure function of (tenant, requirements), so a cached chain
 *     never crosses a tenant boundary.
 *   - Only a successful resolution is cached; an unavailable model re-resolves
 *     on the next call rather than being pinned for the TTL.
 */
export async function resolveInstanceSourcesCached(
  db: DB["db"],
  tenantId: string,
  agentRow: typeof agent.$inferSelect,
  modelPreferences: unknown,
): Promise<InstanceSourceResolution> {
  const hasPreferences =
    modelPreferences !== null &&
    modelPreferences !== undefined &&
    (!Array.isArray(modelPreferences) || modelPreferences.length > 0);
  if (hasPreferences) {
    return resolveInstanceSourcesFromDefinition(
      db,
      tenantId,
      agentRow,
      modelPreferences,
    );
  }

  const modelRequirements =
    agentRow.modelRequirements !== null
      ? ModelRequirements.assert(agentRow.modelRequirements)
      : [];
  const extraModels = modelRequirements.map((r) => r.model);
  const keyExtra = JSON.stringify(modelRequirements);

  try {
    // TTL is read from config by getCachedCatalogSources itself (same strict
    // contract-guaranteed default the workflow deploy path uses) — no local TTL.
    const sources = await getCachedCatalogSources({
      tenantId,
      extraModels,
      keyExtra,
      resolve: async () => {
        const resolution = await resolveInstanceSourcesFromDefinition(
          db,
          tenantId,
          agentRow,
          null,
        );
        if (!resolution.ok) {
          throw new UnresolvedInstanceSourcesError(resolution);
        }
        return resolution.sources;
      },
    });
    // Deep copy: the cache returns its shared entry. A shallow [...] copy would
    // still alias the InferenceSource objects (and their nested defaults), so an
    // in-place mutation downstream of launchSession could corrupt the cached
    // chain for other launches in the TTL window. structuredClone isolates it.
    return { ok: true, sources: structuredClone(sources) };
  } catch (err) {
    if (err instanceof UnresolvedInstanceSourcesError) return err.resolution;
    throw err;
  }
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
    /**
     * Per-launch tool subsetting: mount only the definition tools named here
     * (intersection — a persona can never add a tool the definition lacks).
     * Both the sidecar's tool list and the persisted tool grants are subset, so
     * the restriction is enforced, not just advertised. A persona launch also
     * keeps `systemPrompt` verbatim (no per-instance personalization): the
     * persona prompt is the authoritative role for the session.
     */
    persona?: { toolNames: string[] };
    /** Short route summary from the web client (Myra page context, CL-3527). */
    pageContext?: string;
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

  const resolution = await resolveInstanceSourcesCached(
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

  const definitionToolNames = getToolNamesFromCapabilities(
    agentRow.capabilities ?? null,
  );
  let toolNames = definitionToolNames;
  if (opts.persona) {
    const allowed = new Set(opts.persona.toolNames);
    toolNames = definitionToolNames.filter((name) => allowed.has(name));
  }
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
  let personalAgentPromptComposed = false;
  if (!opts.persona) {
    try {
      const personalized = await composePersonalAgentPromptForInstance(db, {
        tenantId,
        instanceId,
        provider: defaultSourceProvider,
      });
      if (personalized !== null) {
        effectiveSystemPrompt = personalized;
        personalAgentPromptComposed = true;
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
  }

  const pageContext = normalizePageContextInput(opts.pageContext);
  if (pageContext !== undefined) {
    effectiveSystemPrompt = appendPageContextToPrompt(
      effectiveSystemPrompt,
      pageContext,
      defaultSourceProvider,
    );
  }

  // Structured, hash-only launch record for the personal-agent prompt: never
  // log the prompt text itself (it carries customer-specific operator/context
  // data), but the version + content hash let an eval run or an incident
  // review confirm exactly which prompt build shipped without exposing its
  // contents. Gated on the personalized path — PERSONAL_AGENT_PROMPT_VERSION
  // describes Myra's builder, so stamping it on a non-personal launch (e.g.
  // Oat, whose composed prompt was null) would be a lie in the logs.
  if (personalAgentPromptComposed) {
    log.info("Personal-agent launch prompt composed", {
      instanceId,
      agentId,
      promptVersion: PERSONAL_AGENT_PROMPT_VERSION,
      promptContentHash: createHash("sha256")
        .update(effectiveSystemPrompt)
        .digest("hex"),
    });
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

  // Detection: the persisted set just written above (tool grants +
  // requirement grants) is the floor collectGrants should return. A count far
  // below that floor is the signature of a launch that reconciled a partial
  // grant set (a torn-down instance re-syncing with a handful of grants
  // instead of its full template) — cheap to catch here since both counts
  // are already in hand.
  const expectedGrantFloor =
    toolNames.length +
    ((agentRow.grantRequirements ?? []) as GrantRequirementRow[]).length;
  if (expectedGrantFloor > 0 && grants.length < expectedGrantFloor / 2) {
    log.warn("Persisted grant count far below expected at launch", {
      instanceId,
      principalId: instancePrincipalId,
      actualGrantCount: grants.length,
      expectedGrantFloor,
    });
  }

  // Interchange's sendAttachmentPack inserts into session_asset without an
  // upsert. Nothing deletes an instance's session_asset rows when its session
  // ends, so relaunching a previously-stopped instance with the same instanceId
  // collides on the (instance_id, mount_path) primary key and the launch fails
  // with phase=pack. Clear any stale rows for this instance ONCE, before the
  // session is minted (a delete failure must not leave a dangling active
  // session) and outside the retry loop — a retry must not delete rows the
  // current launch just wrote.
  await db.delete(sessionAsset).where(eq(sessionAsset.instanceId, instanceId));

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

  // Clean up the tool + requirement grants written before the launch loop —
  // they're orphaned since no session launched, and would otherwise be
  // returned by collectGrants on the next reconnect attempt with incorrect
  // scope. Only for a genuinely unbound instance (no member_agent_instance
  // row): a bound instance's rows above already hold the CORRECT full set for
  // its current definition, and a subsequent relaunch re-persists the same
  // set from scratch regardless — deleting here bought nothing but a window
  // where the instance sits on a partial grant set. (Deleting only the
  // "system" tool grants here while leaving the "creator"/"invoker"
  // requirement grants persisted moments earlier is an asymmetric partial
  // rollback, not a clean one — it is what let a torn-down instance re-sync
  // with a handful of grants instead of its full template.)
  const hubDb = db as unknown as HubDb;
  const binding = await hubDb.query.memberAgentInstance.findFirst({
    where: eq(memberAgentInstance.instanceId, instanceId),
  });
  if (!binding) {
    await db.transaction(async (tx) => {
      await tx
        .delete(grant)
        .where(
          and(
            eq(grant.principalId, instancePrincipalId),
            eq(grant.origin, "system"),
            like(grant.resource, `${TOOL_GRANT_RESOURCE_PREFIX}%`),
          ),
        );
      await tx
        .delete(grant)
        .where(
          and(
            eq(grant.principalId, instancePrincipalId),
            inArray(grant.origin, ["creator", "invoker"]),
          ),
        );
    });
  } else {
    log.warn(
      "Launch failed for a bound instance; leaving its just-persisted grants intact",
      { instanceId, principalId: instancePrincipalId },
    );
  }

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
  // Capture the narrowed value: property narrowing is lost inside the deferred
  // relaunch closure below, which would widen this back to `string | null`.
  const systemPrompt = agentRow.systemPrompt;

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

  // Coalesce concurrent POST /v1/me relaunches onto one launch and back off
  // after a failing launch, so a wedged launch is not re-attempted every poll
  // (CL-2407). The breaker re-throws the launch cause; we still translate the
  // benign "agent already exists" race into a no-op here.
  try {
    await runDedupedRelaunch(instance.id, async () => {
      await launchAgentSession(
        db,
        sessionService,
        grantStore,
        eventCollectors,
        {
          agentId: instance.agentId,
          instanceId: instance.id,
          instancePrincipalId: instance.principalId,
          tenantId: instance.tenantId,
          tenantDomain: tenantRow.domain,
          systemPrompt,
          now: new Date(),
        },
      );
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
  /**
   * True when the sidecar's own undeploy/cleanup ALSO failed, so a provisioned
   * agent is leaked on the sidecar with no way for the hub to reach it. In this
   * case the hub MUST NOT delete its rows: doing so orphans a zombie sidecar
   * agent with no hub row, and the next mail to that address 502s until the
   * sidecar restarts. Only SessionLaunchError carries this; any other error
   * means no agent was provisioned, so teardown is safe (false).
   */
  leakedAgent: boolean;
};

export function describeLaunchError(err: unknown): LaunchErrorDescription {
  if (err instanceof SessionLaunchError) {
    const cause = err.cause;
    const detail = cause instanceof Error ? cause.message : err.message;
    return { phase: err.phase, detail, leakedAgent: err.leakedAgent };
  }
  if (err instanceof Error) {
    return { phase: null, detail: err.message, leakedAgent: false };
  }
  return { phase: null, detail: String(err), leakedAgent: false };
}

/** One-line message for ops logs (Railway often hides structured fields). */
export function launchFailureLogMessage(
  prefix: string,
  failure: LaunchErrorDescription,
): string {
  const phase = failure.phase ?? "unknown";
  return `${prefix} phase=${phase}: ${failure.detail}`;
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

// Default cadence for the periodic wedge-sweep reconciler (CL-2639).
export const DEFAULT_WEDGE_SWEEP_INTERVAL_MS = 30_000;

// How long an address must stay *continuously* unroutable across ticks before
// the sweep ends-and-relaunches it. The disconnect reconciler is disconnect-
// triggered and passive: it fires only when a `sidecar.disconnect` event is
// observed and only marks the session ended — nothing re-registers the address.
// There is no `sidecar.connect` counterpart on the router (verified against
// @intx/hub-sessions), so a sidecar that fully restarts leaves instances with
// `agent_session.status = 'active'` but no routable address, and mail 502s until
// fixed by hand. This periodic sweep supplies the missing relaunch half from any
// cause (missed disconnect event, hub restart, etc.).
//
// The grace is what keeps the sweep from evicting an agent that is merely
// mid-reconnect (a normal redeploy: the sidecar restarts and re-registers its
// addresses within seconds, and Interchange's `agent.reconnected` restores the
// live session). We cannot use session age for this — `agent_session.updatedAt`
// is never bumped while a session stays `active` (every writer transitions it to
// `ended`), so it equals `createdAt` for the entire life of a live agent and
// carries no signal about reconnect progress. Instead the reconciler tracks the
// first tick at which each address was seen unroutable and only acts once the
// address has been unroutable for the whole grace window; a reconnect that lands
// within the window clears the tracker entry and no relaunch happens. The
// default must exceed both the 90s disconnect grace and typical sidecar
// reconnect-settle time so a healthy redeploy never trips it.
export const DEFAULT_UNROUTABLE_GRACE_MS = 120_000;

// Instance statuses for which a wedge (active session, unroutable address) is
// meaningful and safe to relaunch. `error` is the leaked-agent state — the
// sidecar may still hold the agent, so relaunching risks re-triggering the leak/
// eviction — and `stopped` is an explicit teardown; both are excluded.
export const WEDGE_RELAUNCHABLE_STATUSES = [
  "running",
  "deployed",
  "updating",
] as const;

/**
 * One pass of the wedge sweep. Selects instances with an `active` session and a
 * relaunchable status, then measures *sustained* unroutability against the
 * caller-owned `unroutableSince` tracker: an address is only ended (via
 * `reconcileDisconnectedSession`) and relaunched (via `relaunchInstanceIfNeeded`)
 * once it has been continuously unroutable for `graceMs`. The tracker is passed
 * in (not module-global) so the interval owner holds the state across ticks and
 * tests can drive multiple ticks deterministically.
 *
 * Per tick, for each candidate:
 *  - routable now → drop its tracker entry (healed / reconnected), skip.
 *  - not yet tracked → record `now`, skip (never act on first sighting).
 *  - tracked but within grace → skip.
 *  - tracked past grace → end + relaunch, then drop the entry.
 * Tracker entries for addresses that are no longer candidates (session ended,
 * instance stopped) are pruned so the map cannot grow unbounded.
 *
 * Composes with `registerDisconnectReconciler` without racing or double-
 * relaunching: routability is re-read here and again inside
 * `relaunchInstanceIfNeeded` right before launch, and every relaunch is funneled
 * through the process-local dedup/cooldown breaker, which coalesces a concurrent
 * `/me` relaunch of the same instance onto one launch. (CL-2639)
 */
export async function reconcileWedgedSessions(
  db: DB["db"],
  sidecarRouter: SidecarRouter,
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  unroutableSince: Map<string, number>,
  opts?: { graceMs?: number; now?: number },
): Promise<void> {
  const graceMs = opts?.graceMs ?? DEFAULT_UNROUTABLE_GRACE_MS;
  const now = opts?.now ?? Date.now();

  const routable = new Set(sidecarRouter.getRoutableAddresses());

  const candidates = await db
    .select({
      instanceId: agentInstance.id,
      address: agentInstance.address,
    })
    .from(agentInstance)
    .innerJoin(agentSession, eq(agentInstance.sessionId, agentSession.id))
    .where(
      and(
        eq(agentSession.status, "active"),
        inArray(agentInstance.status, [...WEDGE_RELAUNCHABLE_STATUSES]),
      ),
    );

  const seen = new Set<string>();
  for (const row of candidates) {
    seen.add(row.address);

    if (routable.has(row.address)) {
      unroutableSince.delete(row.address);
      continue;
    }

    const firstSeen = unroutableSince.get(row.address);
    if (firstSeen === undefined) {
      unroutableSince.set(row.address, now);
      continue;
    }
    if (now - firstSeen < graceMs) continue;

    try {
      await reconcileDisconnectedSession(db, sidecarRouter, row.address);
      await relaunchInstanceIfNeeded(
        db,
        sessionService,
        grantStore,
        eventCollectors,
        row.instanceId,
        sidecarRouter,
      );
    } catch (err) {
      log.warn("Failed to reconcile wedged agent session", {
        instanceId: row.instanceId,
        address: row.address,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    unroutableSince.delete(row.address);
  }

  // Prune tracker entries for addresses that are no longer candidates.
  for (const address of [...unroutableSince.keys()]) {
    if (!seen.has(address)) unroutableSince.delete(address);
  }
}

/**
 * Registers the periodic wedge-sweep reconciler on an interval. Owns the
 * per-address unroutability tracker and a reentrancy flag (a slow tick with many
 * wedged rows must not overlap the next). Returns an unsubscribe that clears the
 * timer (mirrors `registerDisconnectReconciler`'s teardown contract). The timer
 * is `unref`'d so it never keeps the process alive on its own.
 */
export function registerWedgeSweepReconciler(deps: {
  db: DB["db"];
  router: SidecarRouter;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  intervalMs?: number;
  graceMs?: number;
}): () => void {
  const { db, router, sessionService, grantStore, eventCollectors } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_WEDGE_SWEEP_INTERVAL_MS;
  const graceMs = deps.graceMs ?? DEFAULT_UNROUTABLE_GRACE_MS;
  const unroutableSince = new Map<string, number>();
  let sweeping = false;

  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void reconcileWedgedSessions(
      db,
      router,
      sessionService,
      grantStore,
      eventCollectors,
      unroutableSince,
      { graceMs },
    )
      .catch((err) => {
        log.warn("Periodic wedge-sweep reconcile tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}
