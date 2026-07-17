/**
 * Copy for the "a workflow needs you" mailbox item the hub writes when a run
 * parks on an `awaitSignal` gate. The hub (`workflow-executor/gate-mail.ts`)
 * owns resolving the owner/tenant/gate state and the durable write; this
 * module owns the subject/body text, so a copy change never touches
 * orchestration code and vice versa.
 */

export function composeGateMailSubject(label: string): string {
  return `A workflow needs you: ${label}`;
}

export function composeGateMailBody(args: {
  label: string;
  runId: string;
  signalName: string;
  choices: string | undefined;
  deepLinkPath: string;
}): string {
  const lines = [
    `The "${args.label}" workflow run is waiting for your input.`,
    "",
    `Run: ${args.runId}`,
    `Workflow: ${args.label}`,
    `Gate: ${args.signalName}`,
  ];
  if (args.choices !== undefined) {
    lines.push(`Expected response: ${args.choices}`);
  }
  lines.push("", `Respond here: ${args.deepLinkPath}`);
  return lines.join("\r\n");
}
