// The "@ + address local part" mention rule: the single wire-level
// contract between the composer (`@corbits/chat-ui`'s
// `mentions.ts`, which derives candidates and splices the picked
// handle into the draft) and this package's own fan-out
// (`routes.ts`'s `POST /channels/:id/messages`). Both sides import the
// functions here rather than re-deriving the rule, so a message the
// composer thinks mentions a participant is always exactly the set the
// server fans a copy to.

import { localPartOf } from "./agent-address";
import type { Part as PartType } from "./parts";

/**
 * A participant entry is an agent address (mention-fannable) rather
 * than a bare principal id when it carries the "@domain" shape every
 * agent address has. Bare principal ids are never fanned a copy: only
 * mentions of other runs' anchors are, since a human participant reads
 * the channel's own timeline directly.
 */
export function isAgentAddress(participant: string): boolean {
  return participant.includes("@");
}

/**
 * The participants an ordinary message @mentions, restricted to agent
 * addresses: the fan-out set for `POST /channels/:id/messages`. A
 * mention is structural — the address's local part, `@`-prefixed,
 * appearing in any `TextPart` of the message — not a full parse of
 * mention syntax; kept minimal per the anchor-mailbox rework's scope.
 */
export function mentionedParticipants(
  parts: readonly PartType[],
  participants: readonly string[],
): string[] {
  const texts = parts
    .filter(
      (part): part is Extract<PartType, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text);
  if (texts.length === 0) return [];
  return participants.filter((participant) => {
    if (!isAgentAddress(participant)) return false;
    const mentionToken = `@${localPartOf(participant)}`;
    return texts.some((text) => text.includes(mentionToken));
  });
}
