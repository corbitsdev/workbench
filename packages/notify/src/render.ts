// What a notification reads like in a mailbox. Every line here is written for
// a person: tool names, run labels, thread titles and handles — never an
// identifier. The identifiers travel in `refs`, where the interface uses them
// to navigate and never to display.
import type { NotificationEvent } from "./events";
import type { NotifyMailRef } from "./mailbox";

export type RenderedNotification = {
  readonly subject: string;
  readonly body: string;
  readonly refs: readonly NotifyMailRef[];
};

const MAX_ARGUMENT_LINES = 12;

function describeToolArguments(args: object): string {
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "It takes no arguments.";
  const shown = entries.slice(0, MAX_ARGUMENT_LINES);
  const lines = shown.map(([key, value]) => `  ${key}: ${format(value)}`);
  if (entries.length > shown.length) {
    lines.push(`  …and ${entries.length - shown.length} more`);
  }
  return ["With:", ...lines].join("\n");
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

export function renderNotification(
  event: NotificationEvent,
): RenderedNotification {
  if (event.kind === "approval") {
    return {
      subject: `Approve “${event.toolName}”?`,
      body: [
        `A workflow is paused and waiting on you before it runs “${event.toolName}”.`,
        describeToolArguments(event.toolArguments),
        "Approve or decline it from your inbox to let the workflow continue.",
      ].join("\n\n"),
      refs: [
        { kind: "approval", id: event.approvalId },
        { kind: "run", id: event.runId },
      ],
    };
  }
  if (event.kind === "run-failure") {
    return {
      subject: `“${event.runLabel}” failed`,
      body: [
        `The run “${event.runLabel}” stopped with an error.`,
        event.error === "" ? "No error detail was reported." : event.error,
      ].join("\n\n"),
      refs: [{ kind: "run", id: event.runId }],
    };
  }
  return {
    subject: `${event.mentionedBy} mentioned you in “${event.threadLabel}”`,
    body: [
      `${event.mentionedBy} mentioned you in “${event.threadLabel}”.`,
      event.excerpt === "" ? "The message has no text." : event.excerpt,
    ].join("\n\n"),
    refs: [{ kind: "thread", id: event.threadId }],
  };
}

/**
 * The stable external identity of a notification, which is also its dedupe key
 * inside the mailbox. An approval keys off the approval itself, so a redelivered
 * register frame never mails twice; the other kinds key off the run or thread
 * plus the moment they happened, since a run can fail once per attempt and a
 * thread can mention someone repeatedly.
 */
export function notificationExternalId(event: NotificationEvent): string {
  if (event.kind === "approval") return event.approvalId;
  if (event.kind === "run-failure") return `${event.runId}:${event.createdAt}`;
  return `${event.threadId}:${event.createdAt}`;
}
