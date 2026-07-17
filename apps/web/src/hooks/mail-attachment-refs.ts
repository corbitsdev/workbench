import type { ChatAttachment, ChatMessage } from "@workbench/chat";
import type { MailAttachmentRef } from "@workbench/shared";

export type { MailAttachmentRef };

// Interchange mail-attachment blob ids are synthesized as
// `blob_<mailId>_<partPath>`; anything else (a parse-file artifact id) must be
// resolved via the workbench artifact download route instead.
export function isMailBlobId(id: string): boolean {
  return id.startsWith("blob_");
}

export function buildAttachmentRefMap(
  refs: readonly MailAttachmentRef[],
): ReadonlyMap<string, ChatAttachment[]> {
  const map = new Map<string, ChatAttachment[]>();
  for (const ref of refs) {
    const chip: ChatAttachment = {
      blobId: ref.artifactId,
      name: ref.name,
      type: ref.type,
      size: ref.size,
    };
    const existing = map.get(ref.mailId);
    if (existing) {
      existing.push(chip);
    } else {
      map.set(ref.mailId, [chip]);
    }
  }
  return map;
}

/**
 * Attach persisted refs onto the transcript bubble that renders from their
 * mail id, skipping any the message already carries (by blobId) so the live
 * and reloaded renders are identical.
 */
export function mergeAttachmentRefs(
  messages: ChatMessage[],
  refMap: ReadonlyMap<string, ChatAttachment[]>,
): ChatMessage[] {
  if (refMap.size === 0) return messages;
  return messages.map((m) => {
    const refs = refMap.get(m.id);
    if (refs === undefined) return m;
    const existingIds = new Set((m.attachments ?? []).map((a) => a.blobId));
    const additions = refs.filter((r) => !existingIds.has(r.blobId));
    if (additions.length === 0) return m;
    return { ...m, attachments: [...(m.attachments ?? []), ...additions] };
  });
}

/**
 * Upsert freshly saved refs into the cached list by (mailId, artifactId), so
 * the chip renders from the query cache immediately after send without
 * waiting for a refetch.
 */
export function upsertMailAttachmentRefs(
  prev: MailAttachmentRef[] | undefined,
  next: readonly MailAttachmentRef[],
): MailAttachmentRef[] {
  const replaced = new Set(next.map((r) => `${r.mailId}:${r.artifactId}`));
  const kept = (prev ?? []).filter(
    (r) => !replaced.has(`${r.mailId}:${r.artifactId}`),
  );
  return [...kept, ...next];
}
