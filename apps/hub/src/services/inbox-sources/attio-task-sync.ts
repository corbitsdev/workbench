import { type } from "arktype";
import { and, eq, like, notInArray } from "drizzle-orm";
import { getLogger } from "@intx/log";
import {
  createAttioTools,
  type AttioToolsConfig,
} from "@workbench/tools-attio";
import type { AgentTool } from "@intx/agent";
import { task } from "../../db/schema";
import type { HubDb } from "../../db";
import { createOwnerTask, updateOwnerTask } from "../../lib/task-store";
import type { TaskRow } from "../../db/schema";
import { readMemberPreferences } from "../../lib/member-preferences";
import type {
  InboxSourceRegistryEntry,
  MemberInboxSourceContext,
} from "../inbox-source-registry";

// CL-3579: syncs a member's Attio tasks into native Workbench tasks on the
// 60s inbox-intake tick (member scope — see inbox-source-registry.ts). Unlike
// the fetch-shaped sources (Linear issues -> mailbox row), this source's job
// is to keep the Workbench `task` table itself in lockstep with Attio, so it
// bypasses `deliverItems` entirely and writes through the existing
// `apps/hub/src/lib/task-store.ts` primitives — the same ones the /me/tasks
// routes use.
//
// Attio's public `/v2/tasks` API has no `updated_at` filter and no webhook
// product (confirmed against the Attio API reference: tasks support GET
// list/single, PATCH, and creation via linked-record note side effects only
// — there is no event/webhook subscription surface for tasks as of this
// writing). A push-based design is therefore not available; this poller is
// the correct shape, not a placeholder for one.
//
// Idempotency: every task this source creates carries a stable
// `sourceRef = attio:task:<taskId>`. Dedupe is a direct lookup on that column
// (`findAnyOwnerTaskBySourceRef` below) — durable in Postgres, so it survives
// a hub restart with no separate mapping table needed. This is a DIFFERENT
// lookup than task-store's own `findOwnerTaskBySourceRef` (that one treats a
// cancelled row as "not found" for triage's re-trigger case; this source
// needs the opposite — see `findAnyOwnerTaskBySourceRef`'s docstring).

const log = getLogger(["services", "inbox-sources", "attio-task-sync"]);

const ATTIO_SOURCE_REF_PREFIX = "attio:task:";

function attioSourceRef(taskId: string): string {
  return `${ATTIO_SOURCE_REF_PREFIX}${taskId}`;
}

function attioTaskUrl(taskId: string): string {
  return `https://app.attio.com/tasks/${taskId}`;
}

// The raw `/v2/tasks` row shape this source reads. `+: "ignore"` keeps every
// other Attio field the API may add without breaking parsing at this
// boundary (per AGENTS.md: parse untrusted API responses through arktype).
export const AttioRawTaskSchema = type({
  id: { task_id: "string" },
  "content_plaintext?": "string | null",
  "deadline_at?": "string | null",
  is_completed: "boolean",
  "created_at?": "string",
  "assignees?": type({ "referenced_actor_id?": "string" }).array(),
});

export type AttioRawTask = typeof AttioRawTaskSchema.infer;

function toolHandler(config: AttioToolsConfig, name: string) {
  const tools: AgentTool[] = createAttioTools(config);
  const tool = tools.find((entry) => entry.definition.name === name);
  if (tool === undefined) {
    throw new Error(`attio-task-sync: could not resolve tool ${name}`);
  }
  if (tool.kind !== "string") {
    throw new Error(`attio-task-sync: expected a string-handler tool ${name}`);
  }
  return tool.handler;
}

async function fetchAttioTasks(
  config: AttioToolsConfig,
  limit: number,
  signal: AbortSignal,
): Promise<AttioRawTask[]> {
  const handler = toolHandler(config, "attio_list_tasks");
  const raw = await handler({ limit, sort: "created_at:desc" }, signal);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const tasks: AttioRawTask[] = [];
  for (const entry of parsed) {
    const validated = AttioRawTaskSchema(entry);
    if (validated instanceof type.errors) continue;
    tasks.push(validated);
  }
  return tasks;
}

/** True when a 404 from `attio_get_task` — the one case that means the task
 * itself is gone (vs. a transient/auth error, which must not be treated as a
 * deletion). Matched on the adapter's error message shape (tools-attio has no
 * typed error class for this), documented here as the seam to revisit if
 * tools-attio ever grows one. */
function isAttioNotFoundError(err: unknown): boolean {
  return err instanceof Error && /Attio API error: 404/.test(err.message);
}

async function attioTaskStillExists(
  config: AttioToolsConfig,
  taskId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const handler = toolHandler(config, "attio_get_task");
  try {
    await handler({ taskId, hydrateLinkedRecords: false }, signal);
    return true;
  } catch (err) {
    if (isAttioNotFoundError(err)) return false;
    // An ambiguous failure (rate limit, network, auth) is not evidence of
    // deletion — leave the task alone rather than risk a false complete.
    throw err;
  }
}

function attioTaskTitle(attioTask: AttioRawTask): string {
  const content = attioTask.content_plaintext;
  if (content !== undefined && content !== null && content.length > 0) {
    return content;
  }
  return "(untitled Attio task)";
}

function attioTaskDue(attioTask: AttioRawTask): string | undefined {
  return attioTask.deadline_at ?? undefined;
}

/** Only actionable when the member's own Attio workspace-member id is known
 * (`attioMemberId`, set via the Owner/member preferences surface — see
 * `packages/workbench-shared/src/index.ts` `MemberPreferences`) AND the task
 * carries at least one assignee. Absent either, the task is still synced
 * (title/status/due) but assignee is left untouched — Attio's assignee ids
 * are workspace-member ids, and this poller has no directory mapping every
 * workspace member id to a Workbench principal, only the polling member's
 * own. Assigning a synced task to a DIFFERENT teammate is therefore out of
 * scope for this pass. */
function isAssignedToSelf(
  attioTask: AttioRawTask,
  selfAttioMemberId: string | undefined,
): boolean {
  if (selfAttioMemberId === undefined) return false;
  const assignees = attioTask.assignees ?? [];
  return assignees.some((a) => a.referenced_actor_id === selfAttioMemberId);
}

/**
 * `task-store.ts`'s `findOwnerTaskBySourceRef` deliberately treats a
 * cancelled row as "not found" (so a re-triggered triage `task_create` gets a
 * fresh task after the member dismisses one) — the opposite of what this
 * source needs: a member-cancelled Attio-synced task must stay dead, never
 * be silently re-created next tick. Queried directly here (cancelled
 * included) so create-vs-skip is decided on the true row state.
 */
async function findAnyOwnerTaskBySourceRef(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; sourceRef: string },
): Promise<TaskRow | null> {
  const rows = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.tenantId, args.tenantId),
        eq(task.ownerPrincipalId, args.ownerPrincipalId),
        eq(task.sourceRef, args.sourceRef),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function syncOneTask(
  db: HubDb,
  member: MemberInboxSourceContext["member"],
  attioTask: AttioRawTask,
  cutoff: Date,
  selfAttioMemberId: string | undefined,
): Promise<void> {
  const sourceRef = attioSourceRef(attioTask.id.task_id);
  const existing = await findAnyOwnerTaskBySourceRef(db, {
    tenantId: member.tenantId,
    ownerPrincipalId: member.memberPrincipalId,
    sourceRef,
  });

  if (existing === null) {
    // Never surface a task that was already done before we ever saw it, or
    // one created before this source's lookback window — bounds the backlog
    // a member sees the moment they flip the toggle on.
    if (attioTask.is_completed) return;
    const createdAt =
      attioTask.created_at !== undefined
        ? new Date(attioTask.created_at)
        : null;
    if (createdAt !== null && createdAt < cutoff) return;
    if (
      selfAttioMemberId !== undefined &&
      !isAssignedToSelf(attioTask, selfAttioMemberId)
    ) {
      return;
    }
    const due = attioTaskDue(attioTask);
    await createOwnerTask(db, {
      tenantId: member.tenantId,
      ownerPrincipalId: member.memberPrincipalId,
      createdByPrincipalId: member.memberPrincipalId,
      title: attioTaskTitle(attioTask),
      source: "agent",
      sourceRef,
      links: [
        {
          kind: "url",
          ref: attioTaskUrl(attioTask.id.task_id),
          label: "Attio task",
        },
      ],
      ...(due !== undefined ? { due } : {}),
    });
    return;
  }

  if (existing.status === "cancelled") return; // user detached it; never revive

  const due = attioTaskDue(attioTask);
  const wantsDone = attioTask.is_completed && existing.status !== "done";
  const wantsReopen = !attioTask.is_completed && existing.status === "done";
  const titleChanged = attioTaskTitle(attioTask) !== existing.title;
  const existingDueIso =
    existing.due !== null ? existing.due.toISOString() : undefined;
  const dueChanged = existingDueIso !== due;

  if (!wantsDone && !wantsReopen && !titleChanged && !dueChanged) return;

  await updateOwnerTask(db, {
    tenantId: member.tenantId,
    ownerPrincipalId: member.memberPrincipalId,
    actorPrincipalId: member.memberPrincipalId,
    id: existing.id,
    ...(titleChanged ? { title: attioTaskTitle(attioTask) } : {}),
    ...(dueChanged ? { due: due ?? null } : {}),
    ...(wantsDone ? { status: "done" as const } : {}),
    ...(wantsReopen ? { status: "open" as const } : {}),
  });
}

/**
 * Deletion semantics: Attio's list endpoint simply omits a deleted task, so a
 * task previously synced here that no longer appears in the latest page is
 * only ONE explanation among several (it also drops off a bounded, sorted
 * page as new tasks arrive). To avoid false completions from pagination, a
 * previously-synced, still-open Workbench task missing from the fetched set
 * is individually re-checked with `attio_get_task`; only a real 404 marks it
 * done. `done` (not `cancelled`) is the least-destructive terminal available
 * on the tasks domain — fully reversible by the member, consistent with
 * every other completion path.
 */
async function reconcileDeletions(
  db: HubDb,
  member: MemberInboxSourceContext["member"],
  config: AttioToolsConfig,
  seenTaskIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  const trackedRows = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.tenantId, member.tenantId),
        eq(task.ownerPrincipalId, member.memberPrincipalId),
        like(task.sourceRef, `${ATTIO_SOURCE_REF_PREFIX}%`),
        notInArray(task.status, ["done", "cancelled"]),
      ),
    );

  for (const row of trackedRows) {
    const sourceRef = row.sourceRef;
    if (sourceRef === null || !sourceRef.startsWith(ATTIO_SOURCE_REF_PREFIX)) {
      continue;
    }
    const attioTaskId = sourceRef.slice(ATTIO_SOURCE_REF_PREFIX.length);
    if (seenTaskIds.has(attioTaskId)) continue;
    try {
      const stillExists = await attioTaskStillExists(
        config,
        attioTaskId,
        signal,
      );
      if (stillExists) continue;
    } catch (err) {
      log.warn("attio-task-sync: deletion check failed; leaving task as-is", {
        tenantId: member.tenantId,
        taskId: row.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      continue;
    }
    await updateOwnerTask(db, {
      tenantId: member.tenantId,
      ownerPrincipalId: member.memberPrincipalId,
      actorPrincipalId: member.memberPrincipalId,
      id: row.id,
      status: "done",
    });
  }
}

function attioToolsConfig(credential: {
  apiKey: string;
  baseURL: string;
}): AttioToolsConfig {
  const config: AttioToolsConfig = { apiKey: credential.apiKey };
  if (credential.baseURL.length > 0) config.baseUrl = credential.baseURL;
  return config;
}

async function handle(ctx: MemberInboxSourceContext): Promise<void> {
  const config = attioToolsConfig(ctx.credential);
  const prefs = await readMemberPreferences(
    ctx.db,
    ctx.tenantId,
    ctx.member.memberPrincipalId,
  );
  const selfAttioMemberId = prefs.attioMemberId;

  const attioTasks = await fetchAttioTasks(
    config,
    ctx.perSourceLimit,
    ctx.signal,
  );

  for (const attioTask of attioTasks) {
    try {
      await syncOneTask(
        ctx.db,
        ctx.member,
        attioTask,
        ctx.lastPollAt ?? ctx.cutoff,
        selfAttioMemberId,
      );
    } catch (err) {
      log.error("attio-task-sync: failed to sync one task", {
        tenantId: ctx.tenantId,
        memberPrincipalId: ctx.member.memberPrincipalId,
        attioTaskId: attioTask.id.task_id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  const seenIds = new Set(attioTasks.map((t) => t.id.task_id));
  await reconcileDeletions(ctx.db, ctx.member, config, seenIds, ctx.signal);
}

/**
 * The Attio task-sync inbox source (CL-3579). Registered under the `attio`
 * key so it shares the `inboxSource:attio` preference and OAuth-capability
 * gate that `INBOX_SOURCE_CATALOG` already derives from the `attio`
 * `briefSource` entry in `credential-provider-catalog.ts` — no catalog
 * change needed, only a registry line (see wiring instructions in the PR).
 */
export const attioTaskSyncInboxSource: InboxSourceRegistryEntry = {
  key: "attio",
  scope: "member",
  handle: async (context) => {
    if (context.scope !== "member") return;
    await handle(context);
  },
};
