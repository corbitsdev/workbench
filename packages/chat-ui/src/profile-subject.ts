// Identity payload for opening a ProfileCard in the shell canvas. Chat-ui
// never mounts the card itself — the host canvas column owns that surface.

import { isAgentAddress } from "@corbits/chat/mentions";

import type { ParticipantRecord } from "./api";

export type ProfileSubject = {
  readonly kind: "agent" | "member";
  readonly address: string;
  readonly handle: string;
  readonly displayName: string;
  readonly initials: string;
};

function initialsOf(source: string): string {
  const words = source
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  const first = words[0]?.charAt(0) ?? "";
  const second =
    words.length > 1
      ? (words[1]?.charAt(0) ?? "")
      : (words[0]?.charAt(1) ?? "");
  const initials = `${first}${second}`.toUpperCase();
  return initials.length > 0 ? initials : "?";
}

export function profileSubjectFromParticipant(
  participant: ParticipantRecord,
): ProfileSubject {
  const isAgent = isAgentAddress(participant.address);
  const displayName = isAgent ? `@${participant.handle}` : participant.handle;
  return {
    kind: isAgent ? "agent" : "member",
    address: participant.address,
    handle: participant.handle,
    displayName,
    initials: initialsOf(participant.handle),
  };
}
