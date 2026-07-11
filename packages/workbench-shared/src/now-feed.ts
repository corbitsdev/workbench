import { type } from "arktype";
import type { MailboxMessage } from "./mailbox";
import type { Task } from "./tasks";

// The "Now" feed is the inbox-as-dashboard composition: everything that needs
// the user's attention right now, in one prioritized list. A gate ask blocks a
// running workflow, so it outranks unread mail, which outranks open tasks.

// Subject prefix Myra's triage handoffs carry. Mailbox rows expose no
// In-Reply-To/thread linkage yet, so handoff-to-raw grouping matches on the
// subject remainder — the simplest correct grouping until threading lands.
export const TRIAGE_SUBJECT_PREFIX = "Myra triaged: ";

// The structural slice of a workflow-run row the feed needs. The web run
// schema lives beside its hook; this keeps the composition decoupled from it.
export const NowRunSchema = type({
  runId: "string",
  kind: "string",
  status: "string",
  createdAt: "string",
});
export type NowRun = typeof NowRunSchema.infer;

export const openTaskStatuses = ["open", "in_progress", "waiting"] as const;

export type NowGateItem = { type: "gate"; run: NowRun };
export type NowMailItem = {
  type: "mail";
  message: MailboxMessage;
  collapsed: MailboxMessage[];
};
export type NowTaskItem = { type: "task"; task: Task };
export type NowItem = NowGateItem | NowMailItem | NowTaskItem;

function byIsoDesc(a: string, b: string): number {
  return b.localeCompare(a);
}

export function buildNowFeed(input: {
  runs: readonly NowRun[];
  messages: readonly MailboxMessage[];
  tasks: readonly Task[];
}): NowItem[] {
  const gates: NowGateItem[] = input.runs
    .filter((run) => run.status === "awaiting")
    .toSorted((a, b) => byIsoDesc(a.createdAt, b.createdAt))
    .map((run) => ({ type: "gate", run }));

  const unread = input.messages.filter((message) => !message.read);
  const collapsedIds = new Set<string>();
  const collapsedByHandoff = new Map<string, MailboxMessage[]>();
  for (const handoff of unread) {
    if (!handoff.subject?.startsWith(TRIAGE_SUBJECT_PREFIX)) continue;
    const rawSubject = handoff.subject.slice(TRIAGE_SUBJECT_PREFIX.length);
    const collapsed = input.messages.filter(
      (message) => message.id !== handoff.id && message.subject === rawSubject,
    );
    if (collapsed.length === 0) continue;
    collapsedByHandoff.set(handoff.id, collapsed);
    for (const message of collapsed) collapsedIds.add(message.id);
  }

  const mail: NowMailItem[] = unread
    .filter((message) => !collapsedIds.has(message.id))
    .toSorted((a, b) => byIsoDesc(a.date, b.date))
    .map((message) => ({
      type: "mail",
      message,
      collapsed: collapsedByHandoff.get(message.id) ?? [],
    }));

  const openSet: readonly string[] = openTaskStatuses;
  const tasks: NowTaskItem[] = input.tasks
    .filter((task) => openSet.includes(task.status))
    .toSorted((a, b) => byIsoDesc(a.updatedAt, b.updatedAt))
    .map((task) => ({ type: "task", task }));

  return [...gates, ...mail, ...tasks];
}
