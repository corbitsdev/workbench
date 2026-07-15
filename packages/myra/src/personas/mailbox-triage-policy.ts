import { splitMailAddress } from "@workbench/hub-agent";
import { TRIAGE_SUBJECT_PREFIX } from "@workbench/shared";

/**
 * Mailbox triage business rules: which senders are eligible for triage, the
 * handoff subject/message-key scheme, and the prompt text a triage session's
 * one turn is fed. The hub's `mailbox-triage` service owns the orchestration
 * (queueing, session spawn, DB writes, teardown) and calls these as pure
 * policy — see `packages/myra/AGENTS.md`-level rule: apps stay generic,
 * packages own the domain rule.
 */

// Exported so task-tools.ts / task-store.ts can recognize a triage-created
// task and force it into `waiting` (see `resolveTriageTaskDefaultStatus`)
// without a second, driftable copy of this string.
export const TRIAGE_TEMPLATE_KEY = "myra-triage";

/**
 * Sender local-parts owned by system rails. Mail from these never triages:
 * `hub` frames are hub-authored notifications, and `myra` is the triage
 * handoff sender itself — triaging it would loop.
 */
const SYSTEM_SENDER_LOCAL_PARTS = new Set(["hub", "myra"]);

/**
 * Sender local-parts used by bounce/mailer-daemon rails. Mail from these
 * never triages — a triage handoff to a bounce address would either loop
 * (auto-reply to an auto-reply) or triage noise no human should see.
 * Matched case-insensitively, and against the base local-part with any
 * `+`-suffix stripped (e.g. `bounces+abc123` matches `bounces`).
 */
const BOUNCE_SENDER_LOCAL_PARTS = new Set([
  "mailer-daemon",
  "postmaster",
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "bounce",
  "bounces",
]);

function localPart(address: string): string {
  return splitMailAddress(address)?.local ?? address;
}

export function isSystemSenderAddress(address: string): boolean {
  return SYSTEM_SENDER_LOCAL_PARTS.has(localPart(address));
}

export function isBounceSenderAddress(address: string): boolean {
  const local = localPart(address).toLowerCase();
  const base = local.split("+")[0] ?? local;
  return BOUNCE_SENDER_LOCAL_PARTS.has(base);
}

export function isTriageHandoffSubject(
  subject: string | null | undefined,
): boolean {
  return (subject ?? "").startsWith(TRIAGE_SUBJECT_PREFIX);
}

/** The handoff subject a triage response is written back under. */
export function triageHandoffSubject(originalSubject: string): string {
  return `${TRIAGE_SUBJECT_PREFIX}${originalSubject}`;
}

/** The dedupe key a triage handoff mailbox item is written under. */
export function triageMessageKey(rowId: string): string {
  return `triage:${rowId}`;
}

export type TriagePromptMessageInput = {
  subject: string;
  from: string;
  to: string;
  rowId: string;
  date?: string;
  body: string;
};

/**
 * Composes the single turn's prompt content a triage session is fed: the
 * inbound message's envelope plus body, framed as an instruction to triage
 * it. The hub decodes the raw mail frame (mail-format infrastructure, not
 * product policy) and hands the decoded parts here.
 */
export function composeTriagePromptMessage(
  input: TriagePromptMessageInput,
): string {
  const lines = [
    "Triage this inbound message.",
    "",
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Mailbox message id: ${input.rowId}`,
  ];
  if (input.date !== undefined) lines.push(`Date: ${input.date}`);
  lines.push("", input.body);
  return lines.join("\n");
}
