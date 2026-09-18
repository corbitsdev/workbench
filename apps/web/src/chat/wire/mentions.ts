// Mirrored from packages/chat/src (see docs/chat-wire-contract.md).

// The composer and the server fan-out both derive mentions from the same
// `ParticipantRecord[]`, so what the composer highlights is always exactly
// who gets a copy.

import type { Part as PartType } from "./parts";
import type { ParticipantRecord } from "./participants";

// Humans (`prn_…`) read the workbench timeline directly and are never
// fanned a copy; only agent addresses are.
export function isAgentAddress(participant: string): boolean {
  return participant.includes("@") && !participant.startsWith("prn_");
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Structural match only (`@handle` at a word boundary) — not a full mention
// syntax parse.
export function mentionedParticipants(
  parts: readonly PartType[],
  participants: readonly ParticipantRecord[],
): string[] {
  const texts = parts
    .filter((part): part is Extract<PartType, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text);
  if (texts.length === 0) return [];
  return participants
    .filter((participant) => isAgentAddress(participant.address))
    .filter((participant) => {
      const mentionPattern = new RegExp(`@${escapeForRegExp(participant.handle)}\\b`);
      return texts.some((text) => mentionPattern.test(text));
    })
    .map((participant) => participant.address);
}
