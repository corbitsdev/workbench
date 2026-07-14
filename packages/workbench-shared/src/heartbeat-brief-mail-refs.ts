import type { MailboxRef } from "./mailbox";

/** Related-row refs for a morning-brief notify mail after persist (CL-3521). */
export function morningBriefMailRefs(artifactId: string): MailboxRef[] {
  const id = artifactId.trim();
  if (id.length === 0) {
    throw new Error("artifactId is required for morning brief mail refs");
  }
  return [{ kind: "artifact", ref: id, label: "Open brief" }];
}