import { and, eq, inArray } from "drizzle-orm";
import {
  schema as intxSchema,
  resolveCredentialRequirement,
  getAncestorChain,
} from "@intx/db";
import { generateId } from "@intx/hub-common";
import {
  createAgent,
  createDefaultDirectorRegistry,
  defineAgent,
  type AuthorizeFn,
} from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";
import { createIsogitStore } from "@workbench/storage-isogit";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AGENT_TEMPLATES,
  LLM_DEFAULT_MODEL,
  PERSONAL_AGENT_NAME,
} from "@workbench/agents";
import type {
  SessionService,
  EventCollectorRegistry,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import {
  createEventCollector,
  type TurnFinalized,
} from "@workbench/event-collector";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import {
  lookupMember,
  reseedAgentTemplateIfStale,
} from "../lib/tenant-provisioning";
import {
  describeLaunchError,
  launchFailureLogMessage,
  isAgentAlreadyExistsError,
  launchAgentSession,
  resolveInstanceSourcesFromDefinition,
  type LaunchErrorDescription,
} from "./agent-provisioning";
import {
  assessPersonalAgentSync,
  refreshInstanceGrantsFromDefinition,
} from "./grant-reconcile";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "myra-threads"]);

const { agent, agentInstance, agentSession, principal, grant, sessionAsset } =
  intxSchema;

export const MYRA_TEMPLATE_KEY = "myra";

/**
 * Raised when a new Myra thread's session could not be launched. The thread's
 * rows are torn down before this is thrown, so a failed create leaves no orphan
 * instance that looks healthy. Carries the launch phase + detail (which names
 * the failing tool package where the sidecar surfaced it) for the HTTP layer.
 */
export class MyraThreadLaunchError extends Error {
  readonly phase: string | null;
  readonly detail: string;
  readonly leakedAgent: boolean;
  constructor(
    description: LaunchErrorDescription,
    options?: { cause?: unknown },
  ) {
    super("Myra thread session launch failed", options);
    this.name = "MyraThreadLaunchError";
    this.phase = description.phase;
    this.detail = description.detail;
    this.leakedAgent = description.leakedAgent;
  }
}

export type MyraThreadRow = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
};

/**
 * A thread as shown in the list, carrying the per-thread `updateAvailable`
 * flag. CL-2518: an OLD thread keeps the toolset its session launched with; we
 * never auto-relaunch a live thread (that evicts it → 502), so a thread whose
 * org def has since gained a tool is surfaced as opt-in updatable. Computed from
 * `assessPersonalAgentSync` against the thread's own instance.
 */
export type MyraThreadListRow = MyraThreadRow & { updateAvailable: boolean };

function defaultThreadLabel(index: number): string {
  if (index === 0) return "Chat";
  return `Chat ${index + 1}`;
}

/**
 * Resolve the Myra agent definition for an active tenant by walking the tenant
 * hierarchy. The instance/session/analytics live in the active (possibly child)
 * tenant, but the definition is shared and usually seeded only in the root org
 * tenant — so we accept any definition in the ancestor chain and pick the most
 * specific one (nearest to the active tenant). Returns null when no Myra
 * definition exists anywhere in the chain.
 */
async function resolveMyraDefinition(
  db: HubDb,
  tenantId: string,
): Promise<typeof agent.$inferSelect | null> {
  const chain = await getAncestorChain(db as never, tenantId);
  const defs = await db.query.agent.findMany({
    where: and(
      inArray(agent.tenantId, chain),
      eq(agent.name, PERSONAL_AGENT_NAME),
    ),
  });
  if (defs.length === 0) return null;

  let best = defs[0]!;
  let bestIdx = chain.indexOf(best.tenantId);
  for (const candidate of defs) {
    const idx = chain.indexOf(candidate.tenantId);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      best = candidate;
      bestIdx = idx;
    }
  }
  return best;
}

export async function listMyraThreads(
  db: HubDb,
  opts: { tenantId: string; memberPrincipalId: string },
): Promise<MyraThreadListRow[]> {
  const rows = await db.query.memberAgentInstance.findMany({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
    ),
    orderBy: [memberAgentInstance.createdAt],
  });

  // Per-thread updateAvailable: each Myra thread is its own instance, so a
  // thread is updatable iff its instance has drifted from the current org def
  // (a tool the def gained after the thread launched). Run the per-instance
  // assessments concurrently — a member has only a handful of threads, so this
  // stays cheap on the list path. (CL-2518)
  return Promise.all(
    rows.map(async (row, index) => {
      const assessment = await assessPersonalAgentSync(
        db as unknown as DB["db"],
        row.instanceId,
      );
      return {
        id: row.id,
        instanceId: row.instanceId,
        label: row.label?.trim() || defaultThreadLabel(index),
        createdAt: row.createdAt.toISOString(),
        updateAvailable: assessment.available,
      };
    }),
  );
}

/**
 * Delete the rows a Myra thread owns in one transaction. Shared by the
 * create-launch-failure rollback and the explicit delete path so both tear a
 * thread down identically.
 *
 * Order is FK-dictated: `agentInstance.sessionId → agentSession` and
 * `agentSession.principalId → principal` are both RESTRICT. `launchAgentSession`
 * inserts the session row before the sidecar call and only marks it `ended` on
 * failure (never deletes it), so the session outlives a failed launch. We must
 * delete the instance, then the session, then the principal — deleting the
 * principal while the ended session still references it raises an FK violation
 * (aborting the rollback and leaving the orphan it was meant to remove).
 */
async function teardownThreadRows(
  db: HubDb,
  opts: { instanceId: string; mappingId: string; instancePrincipalId: string },
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as HubDb;
    await tx
      .delete(grant)
      .where(eq(grant.resource, `instance:${opts.instanceId}`));
    await tx
      .delete(memberAgentInstance)
      .where(eq(memberAgentInstance.id, opts.mappingId));
    await tx.delete(agentInstance).where(eq(agentInstance.id, opts.instanceId));
    await tx
      .delete(agentSession)
      .where(eq(agentSession.principalId, opts.instancePrincipalId));
    await tx
      .delete(principal)
      .where(
        and(eq(principal.refId, opts.instanceId), eq(principal.kind, "agent")),
      );
  });
}

export async function createMyraThread(
  db: HubDb,
  deps: {
    sessionService: SessionService;
    grantStore: GrantStore;
    eventCollectors: EventCollectorRegistry;
  },
  opts: {
    tenantId: string;
    tenantDomain: string;
    memberPrincipalId: string;
    label?: string;
  },
): Promise<{ thread: MyraThreadRow; created: true }> {
  const template = AGENT_TEMPLATES.find((t) => t.key === MYRA_TEMPLATE_KEY);
  if (!template) {
    throw new Error("Myra template is not registered");
  }

  let def = await resolveMyraDefinition(db, opts.tenantId);
  if (!def) {
    throw new Error(
      "Myra org definition is not seeded in this tenant hierarchy",
    );
  }

  // CL-2517: keep THIS tenant's own Myra def current so the new thread launches
  // with the latest tools — a template that later gains a tool (e.g. Linear) is
  // only written at member-join and otherwise never reaches existing tenants.
  // Two deliberate constraints:
  //   - scoped to the tenant's OWN def (`def.tenantId === opts.tenantId`): an
  //     inherited/shared parent def is left to the org seed/admin path, never
  //     rewritten as a side effect of one member creating a thread.
  //   - best-effort: a reseed failure must NOT block thread creation. Launching
  //     with the prior def (missing only the newest tool) beats failing the
  //     create outright. reseedAgentTemplateIfStale is idempotent + a no-op once
  //     current, so this stays cheap on the hot path.
  // Live/old threads are untouched (CL-1651); CL-2518 gives those an opt-in update.
  if (def.tenantId === opts.tenantId) {
    try {
      const { reseeded } = await reseedAgentTemplateIfStale(
        db,
        opts.tenantId,
        template,
      );
      if (reseeded) {
        def = (await resolveMyraDefinition(db, opts.tenantId)) ?? def;
      }
    } catch (err) {
      // log.error (not warn): the hub Sentry sink drops warns, and a persistent
      // reseed failure silently strands a tenant on the old toolset — the exact
      // bug CL-2517 exists to kill. Best-effort still launches with the prior
      // def, but the failure must page someone (and this un-swallows real seed
      // bugs that would otherwise vanish at warn level).
      log.error("Myra def reseed failed; launched thread with stale def", {
        tenantId: opts.tenantId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  const now = new Date();
  const instanceId = generateId("instance");
  let instancePrincipalId = "";

  const existingCount = await db.query.memberAgentInstance.findMany({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
    ),
  });

  const label = opts.label?.trim() || defaultThreadLabel(existingCount.length);

  const mappingId = generateId("instance");

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as HubDb;
    const newPrincipalId = generateId("principal");
    await tx.insert(principal).values({
      id: newPrincipalId,
      tenantId: opts.tenantId,
      kind: "agent",
      refId: instanceId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    instancePrincipalId = newPrincipalId;

    await tx.insert(agentInstance).values({
      id: instanceId,
      agentId: def.id,
      tenantId: opts.tenantId,
      principalId: instancePrincipalId,
      address: `${instanceId}@${opts.tenantDomain}`,
      status: "deployed",
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(memberAgentInstance).values({
      id: mappingId,
      tenantId: opts.tenantId,
      memberPrincipalId: opts.memberPrincipalId,
      templateKey: MYRA_TEMPLATE_KEY,
      agentId: def.id,
      instanceId,
      label,
      createdAt: now,
    });

    for (const action of ["read", "write", "manage"] as const) {
      await tx.insert(grant).values({
        id: generateId("grant"),
        tenantId: opts.tenantId,
        principalId: opts.memberPrincipalId,
        resource: `instance:${instanceId}`,
        action,
        effect: "allow",
        origin: "system",
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  try {
    await launchAgentSession(
      db,
      deps.sessionService,
      deps.grantStore,
      deps.eventCollectors,
      {
        agentId: def.id,
        instanceId,
        instancePrincipalId,
        tenantId: opts.tenantId,
        tenantDomain: opts.tenantDomain,
        systemPrompt: def.systemPrompt ?? "",
        now,
      },
    );
  } catch (err) {
    // No isAgentAlreadyExistsError carve-out here (unlike the agents.ts deploy
    // route): every Myra thread gets a freshly-generated instanceId/principalId
    // and therefore a brand-new agent address that has never been deployed. The
    // orchestrator's reconnect path only ever re-provisions an existing
    // instance's address, so an "already exists" collision cannot occur on this
    // create path — any launch error here is a genuine failure and the
    // half-created rows must be torn down.
    const failure = describeLaunchError(err);
    // A leaked agent means the sidecar's own undeploy also failed, so a
    // provisioned agent survives on the sidecar with no way for the hub to reach
    // it. Tearing down the hub rows here would orphan that zombie: the address
    // keeps routing on the sidecar but has no hub row, so the next mail 502s
    // until a sidecar restart. Keep the rows and mark the instance 'error' so
    // relaunchInstanceIfNeeded (cold-start path; only skips 'stopped'+endedAt)
    // re-attempts and the sidecar's already-exists carve-out adopts the live
    // agent. (CL-2367)
    if (failure.leakedAgent) {
      log.error(
        launchFailureLogMessage(
          "Myra thread session launch failed AND the sidecar leaked the agent; keeping rows",
          failure,
        ),
        {
          instanceId,
          phase: failure.phase,
          detail: failure.detail,
          leakedAgent: failure.leakedAgent,
          error: err instanceof Error ? err : new Error(String(err)),
        },
      );
      const errAt = new Date();
      await db
        .update(agentInstance)
        .set({ status: "error", updatedAt: errAt })
        .where(eq(agentInstance.id, instanceId));
      throw new MyraThreadLaunchError(failure, { cause: err });
    }
    // Log the real Error (not a stringified message) at error level so the
    // Sentry sink routes it through captureException with stack + cause.
    log.error(
      launchFailureLogMessage(
        "Myra thread session launch failed; tearing down thread",
        failure,
      ),
      {
        instanceId,
        phase: failure.phase,
        detail: failure.detail,
        leakedAgent: failure.leakedAgent,
        error: err instanceof Error ? err : new Error(String(err)),
      },
    );
    // Do not leave an orphan thread that looks healthy. Remove the rows we just
    // created so the member does not get a 201 for an instance that never
    // launched and cannot serve chat.
    await teardownThreadRows(db, {
      instanceId,
      mappingId,
      instancePrincipalId,
    });
    throw new MyraThreadLaunchError(failure, { cause: err });
  }

  return {
    created: true,
    thread: {
      id: mappingId,
      instanceId,
      label,
      createdAt: now.toISOString(),
    },
  };
}

/**
 * Opt-in "Update Myra" for a single OLD thread (CL-2518). Brings the thread's
 * agent onto the latest tools by (a) reseeding the tenant's own Myra def if it
 * has drifted from the template, then (b) relaunching THAT thread's session
 * against the current def so the new toolPackages load. Deliberately
 * single-thread and user-initiated: we never auto-relaunch live threads because
 * re-deploying a live agent evicts it from the sidecar router (→ mail 502).
 *
 * Returns the thread row on success, or null when the caller does not own a
 * thread with this id. Throws MyraThreadLaunchError when the relaunch itself
 * fails (so the HTTP layer can surface the failing tool package).
 */
export async function relaunchMyraThread(
  db: HubDb,
  deps: {
    sessionService: SessionService;
    grantStore: GrantStore;
    eventCollectors: EventCollectorRegistry;
    sidecarRouter: SidecarRouter;
  },
  opts: {
    tenantId: string;
    tenantDomain: string;
    memberPrincipalId: string;
    threadId: string;
  },
): Promise<{ thread: MyraThreadRow; applied: boolean } | null> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.id, opts.threadId),
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
    ),
  });
  if (!mapping) return null;

  // Serialize a member's relaunches: a double-click (or two tabs) must not
  // interleave two teardown→launch sequences on the same instance, which would
  // race into "Agent already exists". (CL-2518)
  return runSerializedPerPrincipal(opts.memberPrincipalId, async () => {
    const template = AGENT_TEMPLATES.find((t) => t.key === MYRA_TEMPLATE_KEY);
    if (!template) {
      throw new Error("Myra template is not registered");
    }

    let def = await resolveMyraDefinition(db, opts.tenantId);
    if (!def) {
      throw new Error(
        "Myra org definition is not seeded in this tenant hierarchy",
      );
    }
    // Reseed only the tenant's OWN def (same own-def gate as createMyraThread): an
    // inherited parent def is left to the org seed/admin path, never rewritten as
    // a side effect of one member updating a thread. (CL-2518/CL-2517)
    if (def.tenantId === opts.tenantId) {
      const { reseeded } = await reseedAgentTemplateIfStale(
        db,
        opts.tenantId,
        template,
      );
      if (reseeded) {
        def = (await resolveMyraDefinition(db, opts.tenantId)) ?? def;
      }
    }

    const instance = await db.query.agentInstance.findFirst({
      where: eq(agentInstance.id, mapping.instanceId),
    });
    if (!instance) {
      throw new Error(
        `Myra thread mapping ${opts.threadId} references missing instance ${mapping.instanceId}`,
      );
    }
    if (!instance.principalId) {
      throw new Error(
        `Myra thread instance ${mapping.instanceId} has no principalId; cannot relaunch`,
      );
    }
    const principalId = instance.principalId;

    const row: MyraThreadRow = {
      id: mapping.id,
      instanceId: instance.id,
      label: mapping.label?.trim() || defaultThreadLabel(0),
      createdAt: mapping.createdAt.toISOString(),
    };

    // The whole safety of this rests on NEVER calling launchAgentSession while
    // the thread's address is still routable: launchAgentSession's
    // provision-failure cleanup DELETES the instance's tool grants and ends its
    // session, so an "Agent already exists" there would silently strip the
    // thread of every tool and report success anyway.
    //   1. If the address is live, end the session. endSession (sendAgentUndeploy)
    //      awaits the sidecar's undeploy ack and only then drops the address from
    //      the router — a RESOLVED endSession means the agent is genuinely gone.
    //   2. If endSession rejects (timeout / lost ack), the sidecar may still hold
    //      the agent: do NOT launch (would evict it → 502, CL-1651, or
    //      already-exists → grant wipe). Report not-applied; the member retries.
    //   3. Launch only once the address is confirmed un-routable.
    if (deps.sidecarRouter.getRoutableAddresses().includes(instance.address)) {
      try {
        await deps.sessionService.endSession(
          instance.address,
          "myra_thread_update",
        );
      } catch (err) {
        log.warn(
          "Myra thread update: session teardown did not complete; not relaunching",
          {
            instanceId: instance.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return { thread: row, applied: false };
      }
    }

    // Guard a reconnect re-adding the address between teardown and launch.
    if (deps.sidecarRouter.getRoutableAddresses().includes(instance.address)) {
      log.warn(
        "Myra thread update: address still routable after teardown; not relaunching",
        { instanceId: instance.id },
      );
      return { thread: row, applied: false };
    }

    // Clear this instance's prior session_asset manifest rows before relaunching.
    // launchAgentSession's pack phase does a plain INSERT keyed on the
    // (instanceId, mountPath) PK (session-service.ts sendAttachmentPack); a
    // re-launch of an EXISTING instance would otherwise collide with the rows
    // from its first launch and 503 in the "pack" phase. createMyraThread never
    // hits this (fresh instanceId) — deleting here makes the re-launch
    // materialize fresh against the current def, exactly like a new instance.
    // (CL-2539; the non-idempotent insert itself is tracked upstream in CL-2406.)
    await db
      .delete(sessionAsset)
      .where(eq(sessionAsset.instanceId, instance.id));

    try {
      await launchAgentSession(
        db,
        deps.sessionService,
        deps.grantStore,
        deps.eventCollectors,
        {
          agentId: def.id,
          instanceId: instance.id,
          instancePrincipalId: principalId,
          tenantId: opts.tenantId,
          tenantDomain: opts.tenantDomain,
          systemPrompt: def.systemPrompt ?? "",
          now: new Date(),
        },
      );
    } catch (err) {
      if (isAgentAlreadyExistsError(err)) {
        // A reconnect re-claimed the address inside the launch window.
        // launchAgentSession's cleanup dropped this instance's tool grants AND
        // ended its session row — restore the grants from the def so the thread
        // is not left tool-less, and report not-applied. We INTENTIONALLY leave
        // the session row 'ended': instance.updatedAt was never bumped, so the
        // badge stays (assessPersonalAgentSync still sees org_template_newer) and
        // the member's retry finds the address routable → clean relaunch. Do not
        // "repair" the ended row here — it's the resume signal for the retry. (R1)
        log.warn(
          "Myra thread update: agent re-appeared during relaunch; restoring grants, not applied",
          { instanceId: instance.id },
        );
        await refreshInstanceGrantsFromDefinition(db as unknown as DB["db"], {
          agentId: def.id,
          tenantId: opts.tenantId,
          principalId,
          address: instance.address,
        });
        return { thread: row, applied: false };
      }
      const failure = describeLaunchError(err);
      log.error(
        launchFailureLogMessage("Myra thread relaunch failed", failure),
        {
          instanceId: instance.id,
          phase: failure.phase,
          detail: failure.detail,
          leakedAgent: failure.leakedAgent,
          error: err instanceof Error ? err : new Error(String(err)),
        },
      );
      throw new MyraThreadLaunchError(failure, { cause: err });
    }

    return { thread: row, applied: true };
  });
}

export async function renameMyraThread(
  db: HubDb,
  opts: {
    tenantId: string;
    memberPrincipalId: string;
    threadId: string;
    label: string;
  },
): Promise<MyraThreadRow | null> {
  const label = opts.label.trim();
  if (!label) return null;

  const updated = await db
    .update(memberAgentInstance)
    .set({ label })
    .where(
      and(
        eq(memberAgentInstance.id, opts.threadId),
        eq(memberAgentInstance.tenantId, opts.tenantId),
        eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
        eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
      ),
    )
    .returning();

  const row = updated[0];
  if (!row) return null;

  return {
    id: row.id,
    instanceId: row.instanceId,
    label: row.label?.trim() || label,
    createdAt: row.createdAt.toISOString(),
  };
}

const TITLE_CREDENTIAL_NAME = "Myra Title LLM";
// Cheap, fast model for titling. Served by the same openai-compatible gateway
// (opencode-zen) the Myra LLM credential already points at, so titling works
// with no extra credential — we just pin the flash model on the existing key.
// Shares the canonical id so the title model can't drift from the rest of the app.
const TITLE_MODEL = LLM_DEFAULT_MODEL;
const TITLE_SYSTEM_PROMPT =
  "Generate a concise 3-6 word title for a chat that begins with the user's message. Reply with ONLY the title — no quotes, no punctuation at the end.";

const DEFAULT_LABEL_PATTERN = /^Chat( \d+)?$/;

function isDefaultLabel(label: string | null | undefined): boolean {
  const trimmed = label?.trim() ?? "";
  if (trimmed === "") return true;
  return DEFAULT_LABEL_PATTERN.test(trimmed);
}

function sanitizeTitle(raw: string): string | null {
  let title = raw.trim();
  if (title === "") return null;
  // Strip surrounding matching quotes.
  const first = title[0];
  const last = title[title.length - 1];
  if (
    first !== undefined &&
    (first === '"' || first === "'") &&
    last === first
  ) {
    title = title.slice(1, -1).trim();
  }
  title = title.replace(/\s+/g, " ").trim();
  // Strip a single trailing sentence-final punctuation mark.
  title = title.replace(/[.!?,;:]+$/u, "").trim();
  if (title === "") return null;
  if (title.length > 60) {
    title = title.slice(0, 60).trim();
  }
  if (title === "") return null;
  return title;
}

const ALLOW_ALL_AUTHORIZE: AuthorizeFn = async () => ({
  effect: "allow" as const,
  matchingGrants: [],
  resolvedBy: null,
});

/**
 * Resolve the inference source for title generation. Prefers a cheap optional
 * tenant credential named 'Myra Title LLM'; falls back to the Myra definition's
 * resolved source so titling works with no extra configuration.
 */
async function resolveTitleSource(
  db: HubDb,
  tenantId: string,
): Promise<InferenceSource | null> {
  // Returns null when the optional 'Myra Title LLM' credential is absent (the
  // common case — we then fall back to Myra's own source below). A thrown error
  // means a real fault (ambiguous match, DB failure); let it propagate to the
  // logged best-effort handler in generateMyraThreadTitle rather than swallow it.
  const resolved = await resolveCredentialRequirement(
    db,
    tenantId,
    {
      providerName: TITLE_CREDENTIAL_NAME,
      source: "tenant",
      name: TITLE_CREDENTIAL_NAME,
    },
    null,
    null,
  );

  if (resolved) {
    const providerRow = await db.query.provider.findFirst({
      where: (p, { eq: peq }) => peq(p.id, resolved.providerId),
    });
    const metadata = (providerRow?.metadata ?? {}) as {
      baseURL?: string;
      model?: string;
    };
    if (metadata.baseURL && metadata.model) {
      return {
        id: providerRow?.id ?? generateId("offering"),
        provider: providerRow?.plugin ?? "openai-compatible",
        baseURL: metadata.baseURL,
        apiKey: resolved.secret,
        model: metadata.model,
        defaults: { maxTokens: 64 },
      };
    }
  }

  const def = await resolveMyraDefinition(db, tenantId);
  if (!def) return null;
  const resolution = await resolveInstanceSourcesFromDefinition(
    db,
    tenantId,
    def,
    null,
  );
  if (!resolution.ok) return null;
  const [head] = resolution.sources;
  if (!head) return null;
  // Reuse the Myra credential's key + gateway (opencode-zen) but pin the cheap
  // flash model for titles.
  return {
    ...head,
    model: TITLE_MODEL,
    defaults: { ...head.defaults, maxTokens: 64 },
  };
}

// Best-effort teardown: cleanup must not throw over the real result/error, but
// the failure is logged rather than silently dropped.
const logTeardownError = (op: string) => (err: unknown) =>
  log.warn(`Myra title turn teardown failed: ${op}`, {
    error: err instanceof Error ? err.message : String(err),
  });

// Serializes title turns per member principal. A member's title turns share one
// durable working tree (their audit repo), so they must not run concurrently;
// different principals run fully in parallel. The map holds one tail promise per
// principal (bounded by active members).
const titleLocks = new Map<string, Promise<unknown>>();
function runSerializedPerPrincipal<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = titleLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // The stored tail only keeps the chain alive without an unhandled rejection;
  // the real error is surfaced to the caller via the returned `run` (and logged
  // by generateMyraThreadTitle's handler), so discarding it here is not a swallow.
  titleLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Run ONE non-streaming @intx/agent turn for the title, pumping every emitted
 * InferenceEvent into a hand-rolled event-collector so the turn is recorded to
 * analytics under the thread's instance + tenant (rolls up in /insights). The
 * turn's audit commits land in the member's durable per-principal repo.
 */
async function runTitleTurn(
  db: HubDb,
  opts: {
    tenantId: string;
    memberPrincipalId: string;
    instanceId: string;
    source: InferenceSource;
    firstMessage: string;
  },
): Promise<string | null> {
  // Durable per-(tenant, principal) audit repo on the hub's persistent volume
  // (the same dataDir agent repos live on). One-way: each title turn's audit
  // commits accumulate here as the title-agent-use trail; never deleted. Keyed
  // per principal so each member's titling is its own repo (attribution) and
  // only a member's own concurrent titles ever contend (serialized below).
  const contextDir = join(
    getConfig().hub.dataDir,
    "myra-title",
    opts.tenantId,
    opts.memberPrincipalId,
  );
  const store = await createIsogitStore(contextDir);

  // The collector persists this turn to `inference_turn`, whose `session_id` is
  // a NOT NULL FK to `agent_session`. A fabricated id would violate the FK and
  // fail every title turn, so we key the collector to one durable, reused title
  // session per tenant — created once, idempotently, on first use.
  const instanceRow = await db.query.agentInstance.findFirst({
    where: (i, { eq: ieq }) => ieq(i.id, opts.instanceId),
  });
  if (!instanceRow) return null;

  const titleSessionId = `ses_myra-title-${opts.tenantId}`;
  await db
    .insert(agentSession)
    .values({
      id: titleSessionId,
      tenantId: opts.tenantId,
      agentId: instanceRow.agentId,
      principalId: instanceRow.principalId,
      status: "active",
    })
    .onConflictDoNothing({ target: agentSession.id });

  const def = defineAgent({
    id: `myra-title-${randomUUID()}`,
    systemPrompt: TITLE_SYSTEM_PROMPT,
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: opts.source.provider, model: opts.source.model }],
    },
  });

  const env = {
    sources: [opts.source],
    defaultSource: opts.source.id,
    storage: store,
    workdir: contextDir,
    audit: store,
    authorize: ALLOW_ALL_AUTHORIZE,
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  let finalizedText: string | null = null;
  const onTurnFinalized = (turn: TurnFinalized) => {
    if (turn.status === "completed" && turn.text.trim() !== "") {
      finalizedText = turn.text;
    }
  };

  const collector = createEventCollector({
    db,
    sessionId: titleSessionId,
    instanceId: opts.instanceId,
    tenantId: opts.tenantId,
    onTurnFinalized,
  });

  const agentInst = await createAgent(def, env);

  async function pumpStream(): Promise<void> {
    for await (const event of agentInst.stream()) {
      if (event.type === "message.received") continue;
      await collector.onEvent(event);
    }
  }

  const pumpDone = pumpStream();
  try {
    const result = await agentInst.send(opts.firstMessage);
    await agentInst.close();
    await pumpDone.catch(logTeardownError("pump stream"));
    await collector.abandon();
    const text =
      finalizedText ?? collector.getAccumulatedText() ?? result.reply;
    return text;
  } catch (err) {
    await agentInst.close().catch(logTeardownError("close agent"));
    await pumpDone.catch(logTeardownError("pump stream"));
    await collector.abandon().catch(logTeardownError("abandon collector"));
    throw err;
  }
}

/**
 * Best-effort auto-title for a Myra thread from its first user message via a
 * single recorded @intx/agent inference turn. Never throws to the caller —
 * titling must never break chat. Returns the updated row, or null on no-op /
 * failure (leaving the default label intact).
 */
export async function generateMyraThreadTitle(
  db: HubDb,
  _deps: Record<string, never>,
  opts: {
    tenantId: string;
    memberPrincipalId: string;
    threadId: string;
    firstMessage: string;
  },
): Promise<MyraThreadRow | null> {
  const firstMessage = opts.firstMessage.trim();
  if (firstMessage === "") return null;

  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.id, opts.threadId),
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
    ),
  });
  if (!mapping) return null;
  // Never overwrite a real title.
  if (!isDefaultLabel(mapping.label)) return null;

  try {
    const source = await resolveTitleSource(db, opts.tenantId);
    if (!source) {
      log.warn("Myra title generation skipped: no inference source", {
        tenantId: opts.tenantId,
        threadId: opts.threadId,
      });
      return null;
    }

    const raw = await runSerializedPerPrincipal(opts.memberPrincipalId, () =>
      runTitleTurn(db, {
        tenantId: opts.tenantId,
        memberPrincipalId: opts.memberPrincipalId,
        instanceId: mapping.instanceId,
        source,
        firstMessage,
      }),
    );
    // The title inference turn producing no usable text is a real-world cause of
    // "new chats never get a title" (CL-2449): a model/config fault leaves chat
    // working but the title turn empty. These paths used to return null silently
    // — invisible to operators, since the catch below only WARNs (and WARN is
    // not forwarded to Sentry). Log them so a persistently-empty title turn is
    // diagnosable instead of presenting as an unexplained default label.
    if (raw === null) {
      log.warn(
        "Myra title generation produced no text; leaving default label",
        { tenantId: opts.tenantId, threadId: opts.threadId },
      );
      return null;
    }

    const title = sanitizeTitle(raw);
    if (title === null) {
      log.warn(
        "Myra title generation produced unusable text; leaving default label",
        { tenantId: opts.tenantId, threadId: opts.threadId, raw },
      );
      return null;
    }

    return await renameMyraThread(db, {
      tenantId: opts.tenantId,
      memberPrincipalId: opts.memberPrincipalId,
      threadId: opts.threadId,
      label: title,
    });
  } catch (err) {
    log.warn("Myra title generation failed; leaving default label", {
      threadId: opts.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function deleteMyraThread(
  db: HubDb,
  deps: { sessionService: SessionService },
  opts: { tenantId: string; memberPrincipalId: string; threadId: string },
): Promise<boolean> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.id, opts.threadId),
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
    ),
  });
  if (!mapping) return false;

  const { instanceId } = mapping;

  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });
  // The mapping row references this instance; a missing instance or missing
  // principalId is data corruption, not an expected state. Fail loudly rather
  // than fall back to an empty principalId, which would make the agent_session
  // delete a silent no-op and leave the FK-blocking orphan this teardown exists
  // to remove.
  if (!instance) {
    throw new Error(
      `Myra thread mapping ${opts.threadId} references missing instance ${instanceId}`,
    );
  }
  if (!instance.principalId) {
    throw new Error(
      `Myra thread instance ${instanceId} has no principalId; cannot tear down`,
    );
  }

  if (instance.address) {
    try {
      await deps.sessionService.endSession(
        instance.address,
        "myra_thread_deleted",
      );
    } catch (err) {
      log.warn(
        "Failed to end Myra thread session before delete; leaving to reconciler",
        {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  await teardownThreadRows(db, {
    instanceId,
    mappingId: opts.threadId,
    instancePrincipalId: instance.principalId,
  });

  return true;
}

/**
 * Resolve the thread context for a user acting in a specific (active) tenant.
 * Returns null when the user is not a member of that tenant — the route turns
 * that into a 403. The mail domain is deployment-wide (mirrors
 * `provisionMemberInstances`), not tenant-specific, so it comes from config; the
 * instance/session/analytics land in the active tenant via `tenantId`.
 */
export async function resolveMyraThreadContext(
  db: HubDb,
  userId: string,
  tenantId: string,
): Promise<{
  tenantId: string;
  tenantDomain: string;
  memberPrincipalId: string;
} | null> {
  const { domain } = getConfig().rootTenant;
  const member = await lookupMember(db as never, { tenantId, userId });
  if (!member) return null;
  return {
    tenantId: member.tenantId,
    tenantDomain: domain,
    memberPrincipalId: member.principalId,
  };
}
