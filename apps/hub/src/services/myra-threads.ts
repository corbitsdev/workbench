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
import { createIsogitStore, type GCPolicy } from "@workbench/storage-isogit";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AGENT_TEMPLATES,
  LLM_DEFAULT_MODEL,
  PERSONAL_AGENT_NAME,
} from "@workbench/agents";
import {
  isDefaultMyraThreadLabel,
  myraThreadTitleFromFirstMessage,
} from "@workbench/shared";
import type { SessionService } from "@intx/hub-sessions";
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
import { resolveInstanceSourcesFromDefinition } from "./agent-provisioning";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "myra-threads"]);

const { agent, agentInstance, agentSession, principal, grant } = intxSchema;

export const MYRA_TEMPLATE_KEY = "myra";

export type MyraThreadRow = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
};

export type MyraThreadListRow = MyraThreadRow;

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

  return rows.map((row, index) => ({
    id: row.id,
    instanceId: row.instanceId,
    label: row.label?.trim() || defaultThreadLabel(index),
    createdAt: row.createdAt.toISOString(),
  }));
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
  // Live/old threads are untouched (CL-1651); the org def only reaches a new
  // thread's launch. There is no in-place update path (removed, CL-2667) — a
  // member wanting the latest tools starts a new thread.
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

  // No session launch here (CL-2803): return the moment the rows exist so
  // "+ New chat" is instant. The session is provisioned lazily on first open by
  // the chat surface (useMyraSession → POST /instances/:id/sessions), which
  // cold-launches a never-launched instance and drives the provisioning /
  // error UI with retries. This mirrors the lazy personal-agent provisioning
  // direction (CL-2793) and removes the serialized sidecar round-trips that made
  // create block for 3-5s. A launch failure now surfaces in the chat session
  // lifecycle (provisioning → error), not as a create-time 503.

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

function isDefaultLabel(label: string | null | undefined): boolean {
  const trimmed = label?.trim() ?? "";
  if (trimmed === "") return true;
  return isDefaultMyraThreadLabel(trimmed);
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
 * Write-path reclaim policy for the durable per-principal title repos. They
 * accumulate audit commits for the life of the member, so they use the same
 * thresholds as the hub agent repos with keep-history retention — the trail
 * is durable user data, only loose/pack bloat is reclaimed.
 */
export function titleStoreGcPolicy(): GCPolicy {
  return { ...getConfig().hub.agentGc, retention: "keep-history" };
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
    signal: AbortSignal;
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
  const store = await createIsogitStore(
    contextDir,
    undefined,
    titleStoreGcPolicy(),
  );

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

  // On deadline (CL-2866) close() releases the agent workdir lock so a wedged
  // turn cannot pin the per-principal title repo. It is idempotent, so the
  // success/catch paths below may safely close again.
  const onAbort = () => {
    void agentInst.close().catch(logTeardownError("abort close agent"));
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });

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
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run {@link runTitleTurn} under a hard deadline. The deadline both (a) aborts
 * the turn — firing agentInst.close(), which releases the agent workdir lock
 * within its own closeTimeoutMs regardless of what is wedged — and (b) settles
 * the caller so the per-principal serialization chain advances. We must NOT just
 * await the aborted turn: the observed hang (CL-2866) is in post-inference
 * teardown (close / collector.abandon / isogit audit-commit), and abort cannot
 * unblock a hang *inside* an already-running close() or a DB write. Racing the
 * whole turn caps the caller no matter where it wedges; the orphaned turn's late
 * rejection is swallowed so it does not surface as an unhandled rejection.
 */
async function runTitleTurnBounded(
  db: HubDb,
  opts: {
    tenantId: string;
    memberPrincipalId: string;
    instanceId: string;
    source: InferenceSource;
    firstMessage: string;
  },
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Myra title turn timed out");
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const turn = runTitleTurn(db, { ...opts, signal: controller.signal });
  void turn.catch(() => undefined);
  try {
    return await Promise.race([turn, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Best-effort auto-title for a Myra thread. Persists a first-message fallback
 * immediately, then optionally upgrades via a bounded LLM turn. Never throws —
 * titling must never break chat.
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
  if (!isDefaultLabel(mapping.label)) return null;

  const persistFallback = async (): Promise<MyraThreadRow | null> => {
    try {
      return await renameMyraThread(db, {
        tenantId: opts.tenantId,
        memberPrincipalId: opts.memberPrincipalId,
        threadId: opts.threadId,
        label: myraThreadTitleFromFirstMessage(firstMessage),
      });
    } catch (fallbackErr) {
      log.error("Myra title fallback rename failed; leaving default label", {
        threadId: opts.threadId,
        error:
          fallbackErr instanceof Error
            ? fallbackErr
            : new Error(String(fallbackErr)),
      });
      return null;
    }
  };

  const persisted = await persistFallback();
  if (!persisted) return null;

  try {
    const source = await resolveTitleSource(db, opts.tenantId);
    if (!source) {
      log.error(
        "Myra title generation: no inference source; leaving fallback label",
        { tenantId: opts.tenantId, threadId: opts.threadId },
      );
      return persisted;
    }

    // The deadline lives INSIDE the per-principal serialized region so it
    // clocks the turn's own execution, not the time spent queued behind another
    // member turn. On expiry the deadline caps this turn (CL-2866) so the
    // serialization tail advances instead of staying pinned to a wedged turn;
    // the aborted turn's workdir lock still frees within close()'s own bound.
    const raw = await runSerializedPerPrincipal(opts.memberPrincipalId, () =>
      runTitleTurnBounded(
        db,
        {
          tenantId: opts.tenantId,
          memberPrincipalId: opts.memberPrincipalId,
          instanceId: mapping.instanceId,
          source,
          firstMessage,
        },
        getConfig().hub.myraTitleTurnTimeoutMs,
      ),
    );

    if (raw === null) {
      log.error(
        "Myra title generation produced no text; leaving fallback label",
        { tenantId: opts.tenantId, threadId: opts.threadId },
      );
      return persisted;
    }

    const title = sanitizeTitle(raw);
    if (title === null) {
      log.error(
        "Myra title generation produced unusable text; leaving fallback label",
        { tenantId: opts.tenantId, threadId: opts.threadId, raw },
      );
      return persisted;
    }

    return (
      (await renameMyraThread(db, {
        tenantId: opts.tenantId,
        memberPrincipalId: opts.memberPrincipalId,
        threadId: opts.threadId,
        label: title,
      })) ?? persisted
    );
  } catch (err) {
    log.error("Myra title generation failed; leaving fallback label", {
      threadId: opts.threadId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return persisted;
  }
}

/** Fire-and-forget titling so the HTTP handler never blocks on inference. */
export function scheduleMyraThreadTitle(
  db: HubDb,
  opts: {
    tenantId: string;
    memberPrincipalId: string;
    threadId: string;
    firstMessage: string;
  },
): void {
  void generateMyraThreadTitle(db, {}, opts).catch((err) => {
    log.error("Myra thread title job failed unexpectedly", {
      threadId: opts.threadId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  });
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
 * that into a 403. The mail domain MUST be the domain of the tenant the thread's
 * instance lives in: Interchange derives every launch + mail address from
 * `tenant.domain`, so a thread instance in a subtenant has to be stamped with
 * that subtenant's own domain. Sourcing it from the deployment-root config only
 * coincides when the member tenant IS the root (staging); for a subtenant (prod
 * `abk-labs`) it orphans the instance — registered/looked-up at `@root`, routed
 * at `@subtenant` → deploy-ack "no active instance" and mail 502 (CL-2832).
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
  const member = await lookupMember(db as never, { tenantId, userId });
  if (!member) return null;
  const tenantRow = await db.query.tenant.findFirst({
    where: eq(intxSchema.tenant.id, member.tenantId),
    columns: { domain: true },
  });
  return {
    tenantId: member.tenantId,
    tenantDomain: tenantRow?.domain ?? getConfig().rootTenant.domain,
    memberPrincipalId: member.principalId,
  };
}
