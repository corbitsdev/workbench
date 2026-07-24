import {
  TRIAGE_SUBJECT_PREFIX,
  mailboxRefHref,
  type MailboxMessage,
  type MailboxRef,
} from "./mailbox";
import type { NowItem, NowRun } from "./now-feed";
import type { Task } from "./tasks";

// Client-side Focus classification for the hybrid Inbox shell (CL-4397).
// The wire message has no kind/priority; we derive attention ranking from
// subject, refs, and Now feed membership. Heuristics stay narrow — prefer
// never-pinning noise over over-pinning.

export const focusKinds = [
  "gate",
  "artifact",
  "decision",
  "failure",
  "task",
  "brief",
  "system",
  "other",
] as const;
export type FocusKind = (typeof focusKinds)[number];

export type FocusPriority = "now" | "next" | "later";

/** Matches hub terminal-run subjects (`Workflow run completed|failed: …`). */
const SYSTEM_RUN_SUBJECT = /^Workflow run (?:completed|failed):\s/i;
const FAILURE_SUBJECT =
  /(?:\bfailed\b|\bfailure\b|\berror\b|\bblocked\b|\bneeds you\b)/i;
const BRIEF_SUBJECT = /(?:morning brief|daily brief|heartbeat)/i;

export function isSystemWorkflowMail(message: {
  subject?: string | undefined;
}): boolean {
  const subject = message.subject?.trim() ?? "";
  return SYSTEM_RUN_SUBJECT.test(subject);
}

export function hasRefKind(
  message: Pick<MailboxMessage, "refs">,
  kind: MailboxRef["kind"],
): boolean {
  return (message.refs ?? []).some((ref) => ref.kind === kind);
}

export function isTriageHandoff(
  message: Pick<MailboxMessage, "subject" | "refs">,
): boolean {
  if (hasRefKind(message, "mail")) return true;
  return Boolean(message.subject?.startsWith(TRIAGE_SUBJECT_PREFIX));
}

export function deriveMailFocusKind(
  message: Pick<MailboxMessage, "subject" | "refs">,
): FocusKind {
  if (isSystemWorkflowMail(message)) {
    const subject = message.subject ?? "";
    if (/failed/i.test(subject)) return "failure";
    return "system";
  }
  if (hasRefKind(message, "artifact")) return "artifact";
  if (isTriageHandoff(message)) return "decision";
  const subject = message.subject ?? "";
  if (FAILURE_SUBJECT.test(subject)) return "failure";
  if (BRIEF_SUBJECT.test(subject)) return "brief";
  if (
    hasRefKind(message, "workflow_run") ||
    hasRefKind(message, "workflow_trace")
  ) {
    return "decision";
  }
  return "other";
}

/** Quiet success / pure system noise must never pin into Now cards. */
export function isNoiseMail(
  message: Pick<MailboxMessage, "subject" | "refs">,
): boolean {
  return deriveMailFocusKind(message) === "system";
}

export function focusKindLabel(kind: FocusKind): string {
  switch (kind) {
    case "gate":
      return "Gate";
    case "artifact":
      return "Artifact";
    case "decision":
      return "Decision";
    case "failure":
      return "Failure";
    case "task":
      return "Task";
    case "brief":
      return "Brief";
    case "system":
      return "Run notice";
    case "other":
      return "Mail";
  }
}

/** Lower rank number = higher attention for Now card pin order. */
export function focusKindRank(kind: FocusKind): number {
  switch (kind) {
    case "gate":
      return 0;
    case "failure":
      return 1;
    case "artifact":
      return 2;
    case "decision":
      return 3;
    case "task":
      return 4;
    case "brief":
      return 5;
    case "other":
      return 6;
    case "system":
      return 99;
  }
}

export function focusPriorityForKind(kind: FocusKind): FocusPriority {
  if (kind === "gate" || kind === "failure" || kind === "artifact")
    return "now";
  // Decisions, open tasks, and morning briefs are actionable focus — not
  // queue-only filler. Generic "other" mail stays later and never pins.
  if (kind === "decision" || kind === "task" || kind === "brief") return "next";
  return "later";
}

export type FocusCard =
  | {
      id: string;
      type: "gate";
      kind: "gate";
      priority: FocusPriority;
      title: string;
      summary: string;
      from: string;
      when: string;
      primaryAction: string;
      secondaryAction?: string;
      guidance: string;
      run: NowRun;
    }
  | {
      id: string;
      type: "mail";
      kind: FocusKind;
      priority: FocusPriority;
      title: string;
      summary: string;
      from: string;
      when: string;
      primaryAction: string;
      secondaryAction?: string;
      guidance: string;
      message: MailboxMessage;
      collapsed: MailboxMessage[];
    }
  | {
      id: string;
      type: "task";
      kind: "task";
      priority: FocusPriority;
      title: string;
      summary: string;
      from: string;
      when: string;
      primaryAction: string;
      secondaryAction?: string;
      guidance: string;
      task: Task;
    };

function mailGuidance(
  kind: FocusKind,
  message: Pick<MailboxMessage, "snippet">,
): string {
  switch (kind) {
    case "artifact":
      return "Open the artifact, skim for publish readiness, then decide ship or revise.";
    case "decision":
      return "Review Myra’s recommendation and take the primary action, or open the related run.";
    case "failure":
      return "Something failed or needs you — open the run and unblock it before the next cycle.";
    case "brief":
      return "Skim for decisions, then archive once you’ve captured anything that needs follow-up.";
    case "system":
      return "Run notice — usually safe to archive unless this was unexpected.";
    default:
      return message.snippet?.trim()
        ? "Read the note and decide whether it needs a reply or a task."
        : "Open the message and decide the next step.";
  }
}

function mailActions(kind: FocusKind): {
  primaryAction: string;
  secondaryAction?: string;
} {
  switch (kind) {
    case "artifact":
      return { primaryAction: "Open artifact", secondaryAction: "Archive" };
    case "decision":
      return { primaryAction: "Review", secondaryAction: "Later" };
    case "failure":
      return { primaryAction: "Open run", secondaryAction: "Archive" };
    case "brief":
      return { primaryAction: "Read brief", secondaryAction: "Archive" };
    case "system":
      return { primaryAction: "Open", secondaryAction: "Archive" };
    default:
      return { primaryAction: "Open", secondaryAction: "Archive" };
  }
}

export function toFocusCard(item: NowItem): FocusCard | null {
  if (item.type === "gate") {
    return {
      id: item.run.runId,
      type: "gate",
      kind: "gate",
      priority: "now",
      title: item.run.kind,
      summary: "Waiting for your response",
      from: "Workflow",
      when: item.run.createdAt,
      primaryAction: "Respond",
      secondaryAction: "Open run",
      guidance: "Answer the gate ask so the run can proceed.",
      run: item.run,
    };
  }
  if (item.type === "task") {
    return {
      id: item.task.id,
      type: "task",
      kind: "task",
      priority: focusPriorityForKind("task"),
      title: item.task.title,
      summary:
        item.task.body?.trim() || "Open task that still needs attention.",
      from: "Task",
      when: item.task.updatedAt,
      primaryAction: "Open task",
      guidance:
        item.task.status === "waiting"
          ? "This is waiting on something external — check whether you can unblock it."
          : "Work the task or reassign it so it leaves your open queue.",
      task: item.task,
    };
  }

  const kind = deriveMailFocusKind(item.message);
  if (kind === "system") return null;
  const actions = mailActions(kind);
  let collapsedNote: string | null = null;
  if (item.collapsed.length === 1) {
    collapsedNote = "1 earlier item handled by Myra";
  } else if (item.collapsed.length > 1) {
    collapsedNote = `${item.collapsed.length} earlier items handled by Myra`;
  }
  const snippet = item.message.snippet?.trim() || "No preview available.";
  return {
    id: item.message.id,
    type: "mail",
    kind,
    priority: focusPriorityForKind(kind),
    title: item.message.subject?.trim() || "(no subject)",
    summary: collapsedNote ?? snippet,
    from: item.message.fromDisplay?.trim() || item.message.from || "Workbench",
    when: item.message.date,
    primaryAction: actions.primaryAction,
    ...(actions.secondaryAction
      ? { secondaryAction: actions.secondaryAction }
      : {}),
    guidance: mailGuidance(kind, item.message),
    message: item.message,
    collapsed: item.collapsed,
  };
}

/**
 * Pin the highest-attention Now items into Dia-style cards.
 *
 * Ranking rule (why-not-what — attention order, not chronology):
 *   gate → failure → artifact → decision → task → brief → other
 *
 * Quiet system success is never eligible (`toFocusCard` returns null so it
 * cannot pin). Later-priority cards (generic mail) stay in the command queue
 * only — Now never fills with low-attention noise. Hard cap defaults to 3.
 * Same-rank ties break newer-first.
 */
export function selectNowCards(
  items: readonly NowItem[],
  limit = 3,
): FocusCard[] {
  const cards = items
    .map(toFocusCard)
    .filter((card): card is FocusCard => card !== null)
    .filter((card) => card.priority !== "later")
    .toSorted((a, b) => {
      const rankDiff = focusKindRank(a.kind) - focusKindRank(b.kind);
      if (rankDiff !== 0) return rankDiff;
      return b.when.localeCompare(a.when);
    });
  return cards.slice(0, Math.max(0, limit));
}

export type FocusQueueMeta = {
  kind: FocusKind;
  priority: FocusPriority;
  kindLabel: string;
  primaryAction: string;
  secondaryAction?: string;
  guidance: string;
  summary?: string;
};

export function focusQueueMeta(
  message: Pick<MailboxMessage, "subject" | "refs" | "snippet">,
): FocusQueueMeta {
  const kind = deriveMailFocusKind(message);
  const actions = mailActions(kind);
  const summary = message.snippet?.trim();
  return {
    kind,
    priority: focusPriorityForKind(kind),
    kindLabel: focusKindLabel(kind),
    primaryAction: actions.primaryAction,
    ...(actions.secondaryAction
      ? { secondaryAction: actions.secondaryAction }
      : {}),
    guidance: mailGuidance(kind, message),
    ...(summary ? { summary } : {}),
  };
}

/**
 * First actionable primary ref for a mail focus CTA — artifact, then
 * workflow_run, then workflow_trace. Other ref kinds stay in Related chips.
 */
export function primaryMailActionHref(
  message: Pick<MailboxMessage, "refs">,
): string | null {
  const preferredKinds: MailboxRef["kind"][] = [
    "artifact",
    "workflow_run",
    "workflow_trace",
  ];
  for (const kind of preferredKinds) {
    const ref = (message.refs ?? []).find((r) => r.kind === kind);
    if (ref) return mailboxRefHref(ref);
  }
  return null;
}
