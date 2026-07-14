import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import { deepLink, type MailboxRef, type Task } from "@workbench/shared";
import { getConfig } from "../config";
import { readMemberPreferences } from "./member-preferences";
import { writeMailboxMessage } from "./mailbox-write";
import type { HubDb } from "../db";
import type { MailboxEventBus } from "./mailbox-events";

const log = getLogger(["hub", "deliver-task-mail"]);

const { principal, tenant, user, agent } = intxSchema;

export type TaskMailEvent = "created" | "assigned" | "waiting";

export type DeliverTaskMailArgs = {
  db: HubDb;
  tenantId: string;
  /** The task as it stands after the write that triggered this event. */
  task: Task;
  event: TaskMailEvent;
  /** The principal that caused the event (creator, or the actor updating status). */
  actorPrincipalId: string;
  /**
   * Who the mail goes to. Defaults to the task owner (every event but a real
   * reassignment targets the owner). A reassignment targets the NEW assignee,
   * who may or may not be the owner.
   */
  recipientPrincipalId?: string;
  mailboxEventBus?: MailboxEventBus;
};

async function resolveActorName(
  db: HubDb,
  tenantId: string,
  actorPrincipalId: string,
): Promise<string> {
  const row = await db.query.principal.findFirst({
    where: eq(principal.id, actorPrincipalId),
  });
  if (!row || row.tenantId !== tenantId) return "Someone";
  if (row.kind === "user") {
    const userRow = await db.query.user.findFirst({
      where: eq(user.id, row.refId),
    });
    return userRow?.name ?? "A teammate";
  }
  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, row.refId),
  });
  return agentRow?.name ?? "Your agent";
}

function subjectFor(
  event: TaskMailEvent,
  actorName: string,
  title: string,
): string {
  if (event === "assigned") return `${actorName} assigned you: ${title}`;
  if (event === "waiting") return `${actorName} is waiting on you: ${title}`;
  return `New task: ${title}`;
}

// A synced external ref (Linear issue, Attio task) rendered as a clickable
// Markdown link when it carries a URL, so the reading pane autolinks it instead
// of showing a bare "Synced to: linear" line. Refs without a URL are omitted
// (nothing to link to); the structured `refs` row still surfaces them.
function externalRefLink(ref: Task["externalRefs"][number]): string | null {
  if (!ref.externalUrl) return null;
  return `[${ref.adapterId} · ${ref.externalId}](${ref.externalUrl})`;
}

function bodyFor(args: {
  actorName: string;
  task: Task;
  deepLink: string;
}): string {
  const lines = [args.task.title];
  if (args.task.body) lines.push("", args.task.body);
  const links = args.task.externalRefs
    .map(externalRefLink)
    .filter((link): link is string => link !== null);
  if (links.length > 0) {
    lines.push("", "Synced to:", ...links);
  }
  lines.push("", args.deepLink);
  return lines.join("\n");
}

// The structured refs surfaced as the task mail's "Related" action row: the
// task itself, plus every synced external object that has a URL (a Linear issue
// becomes a `linear` ref; any other adapter a generic `url` ref).
function taskMailRefs(task: Task): MailboxRef[] {
  const refs: MailboxRef[] = [
    { kind: "task", ref: task.id, label: "Open task" },
  ];
  for (const ref of task.externalRefs) {
    if (!ref.externalUrl) continue;
    const kind = ref.adapterId.toLowerCase().includes("linear")
      ? "linear"
      : "url";
    refs.push({
      kind,
      ref: ref.externalUrl,
      label: `${ref.adapterId} · ${ref.externalId}`,
    });
  }
  return refs;
}

/**
 * Deliver a task-activity mail to a task's owner via the existing
 * principal_mailbox write path (see `writeMailboxMessage`) — the same durable
 * inbox row a mail-triage handoff or a workflow gate lands in. Mirrors
 * `deliverMentionMail`'s shape.
 *
 * Self-events (the actor IS the recipient) never mail — a member does not
 * need a notification about their own action. This covers both "you updated
 * your own task" and "you assigned a task to yourself". Best-effort and
 * non-blocking: every failure is caught and logged here so a mail problem
 * never turns a successful task write into a caller-visible error.
 */
export async function deliverTaskMail(
  args: DeliverTaskMailArgs,
): Promise<void> {
  const recipientPrincipalId =
    args.recipientPrincipalId ?? args.task.ownerPrincipalId;
  if (args.actorPrincipalId === recipientPrincipalId) return;

  try {
    const tenantRow = await args.db.query.tenant.findFirst({
      where: eq(tenant.id, args.tenantId),
    });
    if (!tenantRow) {
      log.error("No tenant row for {tenantId}; skipping task mail", {
        tenantId: args.tenantId,
      });
      return;
    }

    const recipientPrincipal = await args.db.query.principal.findFirst({
      where: eq(principal.id, recipientPrincipalId),
    });
    if (!recipientPrincipal || recipientPrincipal.tenantId !== args.tenantId) {
      log.warn(
        "Skipping task mail: recipient {recipientPrincipalId} not found in {tenantId}",
        {
          recipientPrincipalId,
          tenantId: args.tenantId,
        },
      );
      return;
    }

    const prefs = await readMemberPreferences(
      args.db,
      args.tenantId,
      recipientPrincipalId,
    );
    if (prefs.taskMailEnabled === false) return;

    const actorName = await resolveActorName(
      args.db,
      args.tenantId,
      args.actorPrincipalId,
    );

    const conversationBaseUrl =
      getConfig().cors.origins[0] ?? getConfig().auth.baseUrl;
    const taskLink = deepLink("task", args.task.id, conversationBaseUrl);
    const subject = subjectFor(args.event, actorName, args.task.title);
    const body = bodyFor({ actorName, task: args.task, deepLink: taskLink });
    // A real reassignment (an explicit recipient override) is keyed
    // per-recipient so handing the same task to a new person always mails
    // them, while a re-save that leaves the assignee unchanged (task-store
    // only calls this on an actual change) never double-sends to the same
    // person for the same assignment. The synthetic "assigned" event fired
    // on agent-created tasks keeps its original, unsuffixed key — it has
    // always targeted the owner and only ever fires once, at creation.
    const messageKey =
      args.event === "assigned" && args.recipientPrincipalId !== undefined
        ? `task:${args.task.id}:assigned:${recipientPrincipalId}`
        : `task:${args.task.id}:${args.event}`;

    await writeMailboxMessage(
      args.db,
      {
        tenantId: args.tenantId,
        principalId: recipientPrincipalId,
        address: deriveUserMailAddress({
          userRefId: recipientPrincipal.refId,
          domain: tenantRow.domain,
        }),
        fromAddress: `tasks@${tenantRow.domain}`,
        subject,
        body,
        messageKey,
        refs: taskMailRefs(args.task),
      },
      args.mailboxEventBus,
    );
  } catch (err) {
    log.error("Task mail delivery failed", {
      tenantId: args.tenantId,
      taskId: args.task.id,
      event: args.event,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
