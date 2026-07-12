import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { Task } from "@workbench/shared";
import { getConfig } from "../config";
import { readMemberPreferences } from "./member-preferences";
import { writeMailboxMessage } from "./mailbox-write";
import type { HubDb } from "../db";
import type { MailboxEventBus } from "./mailbox-events";

const log = getLogger(["hub", "deliver-task-mail"]);

const { principal, tenant, user, agent } = intxSchema;

const USER_ADDRESS_PREFIX = "usr_";

export type TaskMailEvent = "created" | "assigned" | "waiting";

export type DeliverTaskMailArgs = {
  db: HubDb;
  tenantId: string;
  /** The task as it stands after the write that triggered this event. */
  task: Task;
  event: TaskMailEvent;
  /** The principal that caused the event (creator, or the actor updating status). */
  actorPrincipalId: string;
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

function subjectFor(event: TaskMailEvent, actorName: string, title: string): string {
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
    const adapters = args.task.externalRefs.map((ref) => ref.adapterId).join(", ");
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
 * Self-events (the actor IS the owner) never mail — a member does not need a
 * notification about their own action. Best-effort and non-blocking: every
 * failure is caught and logged here so a mail problem never turns a
 * successful task write into a caller-visible error.
 */
export async function deliverTaskMail(args: DeliverTaskMailArgs): Promise<void> {
  if (args.actorPrincipalId === args.task.ownerPrincipalId) return;

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

    const ownerPrincipal = await args.db.query.principal.findFirst({
      where: eq(principal.id, args.task.ownerPrincipalId),
    });
    if (!ownerPrincipal || ownerPrincipal.tenantId !== args.tenantId) {
      log.warn("Skipping task mail: owner {ownerPrincipalId} not found in {tenantId}", {
        ownerPrincipalId: args.task.ownerPrincipalId,
        tenantId: args.tenantId,
      });
      return;
    }

    const prefs = await readMemberPreferences(
      args.db,
      args.tenantId,
      args.task.ownerPrincipalId,
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

    await writeMailboxMessage(
      args.db,
      {
        tenantId: args.tenantId,
        principalId: args.task.ownerPrincipalId,
        address: `${USER_ADDRESS_PREFIX}${ownerPrincipal.refId}@${tenantRow.domain}`,
        fromAddress: `tasks@${tenantRow.domain}`,
        subject,
        body,
        messageKey: `task:${args.task.id}:${args.event}`,
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
