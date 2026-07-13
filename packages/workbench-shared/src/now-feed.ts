import { type } from "arktype";
import type { MailboxMessage } from "./mailbox";
import type { Task } from "./tasks";

// The "Now" feed is the inbox-as-dashboard composition: everything that needs
// the user's attention right now, in one prioritized list. A gate ask blocks a
// running workflow, so it outranks unread mail, which outranks open tasks.

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

// Subject prefix Myra's triage handoffs carried before CL-3507 added a
// structured `mail` ref. Existing mailbox rows written before this change
// deployed have no refs at all, so the ref-based grouping below must fall back
// to this match for those rows — otherwise every pre-existing triage handoff
// ungroups from its raw source mail the moment this ships.
const TRIAGE_SUBJECT_PREFIX = "Myra triaged: ";

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
  const byId = new Map(input.messages.map((message) => [message.id, message]));
  const collapsedIds = new Set<string>();
  const collapsedByHandoff = new Map<string, MailboxMessage[]>();
  // A triage handoff links to the raw mail it triaged via a `mail` ref (its
  // source row id). Collapse the referenced raw message under the handoff by
  // that structured linkage. Rows written before CL-3507 carry no refs at
  // all, so those fall back to the legacy subject-prefix match.
  for (const handoff of unread) {
    const sourceIds = (handoff.refs ?? [])
      .filter((ref) => ref.kind === "mail")
      .map((ref) => ref.ref);
    let collapsed: MailboxMessage[];
    if (sourceIds.length > 0) {
      collapsed = sourceIds
        .map((id) => byId.get(id))
        .filter(
          (message): message is MailboxMessage =>
            message !== undefined && message.id !== handoff.id,
        );
    } else if (handoff.subject?.startsWith(TRIAGE_SUBJECT_PREFIX)) {
      const rawSubject = handoff.subject.slice(TRIAGE_SUBJECT_PREFIX.length);
      collapsed = input.messages.filter(
        (message) =>
          message.id !== handoff.id && message.subject === rawSubject,
      );
    } else {
      continue;
    }
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
