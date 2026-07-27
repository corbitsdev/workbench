import type { HubDb } from "../db";
import { mailboxAddressForMember } from "@workbench/shared";
import { writeMailboxMessage } from "./mailbox-write";
import { writeArtifactDeduped } from "../tools/write-artifact";
import { resolvePrincipalIdsByRefId } from "./tenant-member-routing";

export type InboxBatchArtifact = {
  title: string;
  body: string;
  kind: string;
  /** Required — tenant-scoped dedupe key for writeArtifactDeduped. */
  sourceRef: string;
  jobLabel?: string;
};

export type InboxBatchDelivery = {
  /**
   * Recipient's auth refId — the routing key (CL-4429). Callers hold a
   * `{ refId, displayName }` pair chosen at intake and stored in the schedule
   * payload; they never hold (and must never hard-code) a tenant principal id.
   */
  refId: string;
  subject: string;
  body: string;
  /** Idempotency key for writeMailboxMessage (repeat = no re-mail). */
  messageKey: string;
  artifact?: InboxBatchArtifact;
};

export type InboxDeliverBatchArgs = {
  tenantId: string;
  /** Actor principal (writer of artifacts). */
  actorPrincipalId: string;
  /** Local-part for From: (e.g. "daily-linkedin" → daily-linkedin@domain). */
  fromLocalPart: string;
  /**
   * The firing member's `usr_` address. Supplies the mail DOMAIN for both the
   * From: address and each recipient's address, which is built from their refId.
   * A stored `{ refId, displayName }` pair carries no domain, so this is the
   * only domain source that travels with a run.
   */
  userAddress: string;
  deliveries: InboxBatchDelivery[];
};

export type InboxDeliverBatchResult = {
  delivered: {
    refId: string;
    principalId: string;
    address: string;
    messageKey: string;
    artifactId?: string;
    sourceRef?: string;
    mailWritten: boolean;
  }[];
  /**
   * Recipients deliberately passed over, each with a plain-language reason.
   * The stored selection is a snapshot (CL-4429's accepted tradeoff), so a
   * departed member leaves a dead refId behind until the schedule is edited.
   * That is not an error — the rest of the batch is still correct — but it must
   * never be silent, or a person quietly stops receiving their drafts and
   * nothing in the run says so.
   */
  skipped: { refId: string; reason: string }[];
  errors: { refId: string; error: string }[];
};

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

/**
 * Persist optional artifacts (sourceRef-deduped) and write one inbox row per
 * delivery via writeMailboxMessage. One hub call fans out to N humans without
 * LLM `write_artifact` / `mail_send` loops.
 *
 * Resolves fully rather than rejecting: a per-recipient failure is recorded in
 * `errors` and an unroutable recipient in `skipped`, so one bad row can never
 * abort the batch and discard the deliveries that did succeed.
 */
export async function deliverInboxBatch(
  db: HubDb,
  args: InboxDeliverBatchArgs,
): Promise<InboxDeliverBatchResult> {
  const fromLocalPart = requireNonEmpty(args.fromLocalPart, "fromLocalPart");
  const userAddress = requireNonEmpty(args.userAddress, "userAddress");
  const at = userAddress.lastIndexOf("@");
  if (at <= 0 || at === userAddress.length - 1) {
    throw new Error(`userAddress must be a usr_ mailbox, got: ${userAddress}`);
  }
  const domain = userAddress.slice(at + 1);
  const fromAddress = `${fromLocalPart}@${domain}`;

  if (!Array.isArray(args.deliveries) || args.deliveries.length === 0) {
    throw new Error("deliveries must contain at least one entry");
  }

  const delivered: InboxDeliverBatchResult["delivered"] = [];
  const skipped: InboxDeliverBatchResult["skipped"] = [];
  const errors: InboxDeliverBatchResult["errors"] = [];

  // One lookup for the whole batch: refId → this tenant's user principal id.
  const principalIdByRefId = await resolvePrincipalIdsByRefId(
    db,
    args.tenantId,
    args.deliveries.map((d) => (typeof d.refId === "string" ? d.refId : "")),
  );

  for (const delivery of args.deliveries) {
    let refId = "";
    try {
      refId = requireNonEmpty(delivery.refId, "refId");
      const principalId = principalIdByRefId.get(refId);
      if (principalId === undefined) {
        skipped.push({
          refId,
          reason: `no active member with refId "${refId}" in this tenant — they may have left; edit the schedule's recipient list to remove them`,
        });
        continue;
      }

      const subject = requireNonEmpty(delivery.subject, "subject");
      const body = requireNonEmpty(delivery.body, "body");
      const messageKey = requireNonEmpty(delivery.messageKey, "messageKey");
      const address = mailboxAddressForMember(userAddress, refId);

      let artifactId: string | undefined;
      let sourceRef: string | undefined;

      if (delivery.artifact !== undefined) {
        const art = delivery.artifact;
        sourceRef = requireNonEmpty(art.sourceRef, "artifact.sourceRef");
        const title = requireNonEmpty(art.title, "artifact.title");
        const artBody = requireNonEmpty(art.body, "artifact.body");
        const kind = requireNonEmpty(art.kind, "artifact.kind");
        const jobLabel =
          typeof art.jobLabel === "string" && art.jobLabel.trim() !== ""
            ? art.jobLabel.trim()
            : fromLocalPart;

        const written = await writeArtifactDeduped({
          db,
          tenantId: args.tenantId,
          principalId: args.actorPrincipalId,
          title,
          body: artBody,
          kind,
          source: { job: jobLabel, refId, messageKey },
          ownerPrincipalId: principalId,
          sourceRef,
        });
        artifactId = written.artifactId;
      }

      const mail = await writeMailboxMessage(db, {
        tenantId: args.tenantId,
        principalId,
        address,
        fromAddress,
        subject,
        body,
        messageKey,
        ...(artifactId !== undefined
          ? {
              refs: [
                { kind: "artifact" as const, ref: artifactId, label: subject },
              ],
            }
          : {}),
      });

      const row: InboxDeliverBatchResult["delivered"][number] = {
        refId,
        principalId,
        address,
        messageKey,
        mailWritten: mail !== null,
      };
      if (artifactId !== undefined) row.artifactId = artifactId;
      if (sourceRef !== undefined) row.sourceRef = sourceRef;
      delivered.push(row);
    } catch (err) {
      errors.push({
        refId: refId || "unknown",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { delivered, skipped, errors };
}
