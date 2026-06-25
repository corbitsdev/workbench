import { and, eq } from "drizzle-orm";
import { schema as intxSchema, resolveCredentialRequirement } from "@intx/db";
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
import { AGENT_TEMPLATES, PERSONAL_AGENT_NAME } from "@workbench/agents";
import type {
  SessionService,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import {
  createEventCollector,
  type TurnFinalized,
} from "@workbench/event-collector";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { lookupMember, getRootTenantId } from "../lib/tenant-provisioning";
import {
  describeLaunchError,
  launchAgentSession,
  resolveInstanceSourcesFromDefinition,
  type LaunchErrorDescription,
} from "./agent-provisioning";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "myra-threads"]);

const { agent, agentInstance, agentSession, principal, grant } = intxSchema;

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

function defaultThreadLabel(index: number): string {
  if (index === 0) return "Chat";
  return `Chat ${index + 1}`;
}

export async function listMyraThreads(
  db: HubDb,
  opts: { tenantId: string; memberPrincipalId: string },
): Promise<MyraThreadRow[]> {
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

  const def = await db.query.agent.findFirst({
    where: and(
      eq(agent.tenantId, opts.tenantId),
      eq(agent.name, PERSONAL_AGENT_NAME),
    ),
  });
  if (!def) {
    throw new Error("Myra org definition is not seeded for this tenant");
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
        "Myra thread session launch failed AND the sidecar leaked the agent; keeping rows and marking instance error",
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
    log.error("Myra thread session launch failed; tearing down thread", {
      instanceId,
      phase: failure.phase,
      detail: failure.detail,
      leakedAgent: failure.leakedAgent,
      error: err instanceof Error ? err : new Error(String(err)),
    });
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
const TITLE_MODEL = "deepseek-v4-flash";
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
  ).catch(() => null);

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

  const def = await db.query.agent.findFirst({
    where: and(
      eq(agent.tenantId, tenantId),
      eq(agent.name, PERSONAL_AGENT_NAME),
    ),
  });
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
    sessionId: generateId("session"),
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
    await pumpDone.catch(() => undefined);
    await collector.abandon();
    const text =
      finalizedText ?? collector.getAccumulatedText() ?? result.reply;
    return text;
  } catch (err) {
    await agentInst.close().catch(() => undefined);
    await pumpDone.catch(() => undefined);
    await collector.abandon().catch(() => undefined);
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
    if (raw === null) return null;

    const title = sanitizeTitle(raw);
    if (title === null) return null;

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

export async function resolveMyraThreadContext(
  db: HubDb,
  userId: string,
): Promise<{
  tenantId: string;
  tenantDomain: string;
  memberPrincipalId: string;
} | null> {
  const { domain } = getConfig().rootTenant;
  const rootTenantId = await getRootTenantId(db as never);
  const member = rootTenantId
    ? await lookupMember(db as never, { tenantId: rootTenantId, userId })
    : null;
  if (!member) return null;
  return {
    tenantId: member.tenantId,
    tenantDomain: domain,
    memberPrincipalId: member.principalId,
  };
}
