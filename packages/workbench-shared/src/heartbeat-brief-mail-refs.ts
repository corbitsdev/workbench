import type { MailboxRef } from "./mailbox";

/** Related-row refs for a morning-brief notify mail after persist (CL-3521). */
export function morningBriefMailRefs(
  artifactId: string,
  runId: string,
  workflowLabel = "Company Heartbeat",
): MailboxRef[] {
  const id = artifactId.trim();
  if (id.length === 0) {
    throw new Error("artifactId is required for morning brief mail refs");
  }
  const run = runId.trim();
  if (run.length === 0) {
    throw new Error("runId is required for morning brief mail refs");
  }
  const label = workflowLabel.trim() || "run";
  return [
    { kind: "artifact", ref: id, label: "Open brief" },
    { kind: "workflow_run", ref: run, label: `Open ${label}` },
  ];
}

/**
 * Composes the morning-brief notify mail's exact `mail_send` argument shape
 * (CL-4232): `{ to, subject, content, refs }`. Consolidating the addressing +
 * refs assembly into one producer means the notify step reads this tool's
 * `content` output verbatim, with no per-argument renames at the workflow
 * definition layer.
 */
export function morningBriefNotifyMail(params: {
  userAddress: string;
  title: string;
  body: string;
  artifactId: string;
  runId: string;
  workflowLabel?: string;
}): { to: string; subject: string; content: string; refs: MailboxRef[] } {
  const to = params.userAddress.trim();
  if (to.length === 0) {
    throw new Error("userAddress is required for the morning brief mail");
  }
  const subject = params.title.trim();
  if (subject.length === 0) {
    throw new Error("title is required for the morning brief mail subject");
  }
  const refs = morningBriefMailRefs(
    params.artifactId,
    params.runId,
    params.workflowLabel,
  );
  return { to, subject, content: params.body, refs };
}
