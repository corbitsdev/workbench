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