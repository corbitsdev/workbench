import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { Task } from "@workbench/shared";
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

function bodyFor(args: {
  actorName: string;
  task: Task;
  deepLink: string;
}): string {
  const lines = [args.task.title];
  if (args.task.body) lines.push("", args.task.body);
  if (args.task.externalRefs.length > 0) {
    const adapters = args.task.externalRefs
      .map((ref) => ref.adapterId)
      .join(", ");
    lines.push("", `Synced to: ${adapters}`);
  }
  lines.push("", args.deepLink);
  return lines.join("\n");
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
    const deepLink = `${conversationBaseUrl}/inbox?task=${args.task.id}`;
    const subject = subjectFor(args.event, actorName, args.task.title);
    const body = bodyFor({ actorName, task: args.task, deepLink });
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
