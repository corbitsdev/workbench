// Pure @-mention logic for the composer: detecting an in-progress mention at
// the caret, deriving mentionable candidates from a channel's participant
// records, filtering them against the query, and splicing a chosen handle
// back into the draft. No DOM, no fetch — kept pure so it is unit-testable
// without mounting anything.
//
// A candidate's `handle` comes straight off the participant record the hub
// returns (`chat/participants`, settings-backed — see
// `packages/chat/src/participants.ts`), the same friendly, deduplicated
// mention name `mentionedParticipants` in `packages/chat/src/routes.ts`
// matches against — never the instance-id local part. Filtering to agent
// addresses delegates to `@corbits/chat`'s `isAgentAddress`, the same
// function the server's fan-out uses, so the candidate set is always
// exactly the set the server will fan a copy to. `label` is a friendlier
// string shown alongside the handle in the popover only.

import { isAgentAddress } from "@corbits/chat/mentions";
import { handleFromName } from "@corbits/chat/participants";
import type { ParticipantRecord } from "./api";

export type MentionCandidate = {
  readonly id: string;
  readonly handle: string;
  readonly label: string;
};

/**
 * A softer label for a handle like `launch-planner` or `qa_bot`:
 * word-separators become spaces and each word is capitalized, giving
 * "Launch Planner" — falls back to the raw handle when that would be empty.
 */
function readableLabel(handle: string): string {
  const words = handle.split(/[-_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return handle;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The mentionable candidates for a channel: its agent-address participants
 * (the same set `mentionedParticipants` fans a copy to on the server), each
 * keyed by its own settings-held handle so a picked candidate always
 * inserts text the server will actually match.
 */
export function mentionCandidatesFromParticipants(
  participants: readonly ParticipantRecord[],
): readonly MentionCandidate[] {
  return participants
    .filter((participant) => isAgentAddress(participant.address))
    .map((participant) => ({
      id: participant.address,
      handle: participant.handle,
      label: readableLabel(participant.handle),
    }));
}

/**
 * The intent a picked "bring in" candidate carries into the send path:
 * `POST .../messages`'s optional `invite` entries (see
 * `packages/chat/src/routes.ts`'s `MessageInviteEntry`) — invited
 * server-side, before the send, so the mention it rode in on fans out
 * normally the instant the message itself lands. Never constructed for
 * an existing-participant candidate, which needs no invite at all.
 */
export type MentionInviteIntent =
  | { readonly kind: "agent"; readonly definitionId: string }
  | {
      readonly kind: "person";
      readonly principalId: string;
      readonly name: string;
    };

/**
 * A single popover row, tagged with which group it belongs to:
 * "participant" (the channel's existing agent participants — unchanged
 * from before) or "bring-in" (a workspace member or invitable agent who
 * isn't in the channel yet). Only a "bring-in" row carries `invite` —
 * picking it both inserts the mention text and marks the intent the
 * send path acts on.
 */
export type MentionOption =
  | { readonly group: "participant"; readonly candidate: MentionCandidate }
  | {
      readonly group: "bring-in";
      readonly candidate: MentionCandidate;
      readonly invite: MentionInviteIntent;
    };

/** A workspace member not yet in this workbench — the same reduced shape
 * `NewChannelDialog`'s `listMembers` already returns (see
 * `new-channel-dialog.tsx`'s `PersonOption`), re-declared here so this
 * module doesn't import a dialog-owned type for one field pair. */
export type BringInMember = {
  readonly id: string;
  readonly displayName: string;
};

/** An invitable agent definition — the same reduced shape `GET
 * .../invitable` already returns (see `api.ts`'s `InvitableDefinition`). */
export type BringInAgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
};

/**
 * The "Bring in…" group's candidates: every workspace member not
 * already a participant, plus every invitable agent definition — each
 * paired with the `MentionInviteIntent` picking it will carry. A
 * member's handle is derived from their display name the same way the
 * server derives a freshly-joined human participant's own handle
 * (`handleFromName`), so the inserted mention text is exactly what the
 * server will recognize once the invite lands.
 */
export function bringInOptionsFromMembersAndAgents(
  members: readonly BringInMember[],
  invitableAgents: readonly BringInAgentDefinition[],
  participants: readonly ParticipantRecord[],
): readonly MentionOption[] {
  const participantAddresses = new Set(
    participants.map((participant) => participant.address),
  );
  const memberOptions: MentionOption[] = members
    .filter((member) => !participantAddresses.has(member.id))
    .map((member) => {
      const handle = handleFromName(member.displayName, member.id);
      return {
        group: "bring-in",
        candidate: { id: member.id, handle, label: member.displayName },
        invite: {
          kind: "person",
          principalId: member.id,
          name: member.displayName,
        },
      };
    });
  const agentOptions: MentionOption[] = invitableAgents.map((agent) => {
    const displayName = agent.description ?? agent.name;
    const handle = handleFromName(displayName, agent.id);
    return {
      group: "bring-in",
      candidate: { id: agent.id, handle, label: displayName },
      invite: { kind: "agent", definitionId: agent.id },
    };
  });
  return [...memberOptions, ...agentOptions];
}

/**
 * The full popover option list: existing participants first, then the
 * "Bring in…" group — mirrors the order `mentionCandidatesFromParticipants`
 * already contributes candidates in, so switching a channel from having
 * no bring-in candidates to having some never reorders the participant
 * rows a sender already knows.
 */
export function mentionOptionsFromChannel(
  participants: readonly ParticipantRecord[],
  members: readonly BringInMember[],
  invitableAgents: readonly BringInAgentDefinition[],
): readonly MentionOption[] {
  const participantOptions: MentionOption[] = mentionCandidatesFromParticipants(
    participants,
  ).map((candidate) => ({ group: "participant", candidate }));
  return [
    ...participantOptions,
    ...bringInOptionsFromMembersAndAgents(
      members,
      invitableAgents,
      participants,
    ),
  ];
}

/**
 * `MentionOption`s whose candidate handle or label starts with the
 * query, case-insensitively — the grouped analog of
 * `filterMentionCandidates`, used once the popover has both groups to
 * show.
 */
export function filterMentionOptions(
  options: readonly MentionOption[],
  query: string,
): readonly MentionOption[] {
  const needle = query.toLowerCase();
  return options.filter(
    (option) =>
      option.candidate.handle.toLowerCase().startsWith(needle) ||
      option.candidate.label.toLowerCase().startsWith(needle),
  );
}

export type MentionQuery = {
  /** Index of the "@" that opened this mention, for splicing the result back in. */
  readonly start: number;
  /** Text typed after the "@" so far. */
  readonly query: string;
};

/**
 * Looks backward from the caret for an open "@mention": an "@" not
 * preceded by a word character, with no whitespace between it and the
 * caret. Returns `null` when the caret is not inside one — including right
 * after a mention that was closed by a space.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? "" : upToCaret[at - 1];
  if (before !== undefined && /\S/.test(before)) return null;
  const query = upToCaret.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * Candidates whose handle or label starts with the query, case-insensitively
 * — matching on the label too so typing a readable prefix still finds the
 * handle it would insert. An empty query matches everyone — the popover
 * opens on a bare "@".
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): readonly MentionCandidate[] {
  const needle = query.toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.handle.toLowerCase().startsWith(needle) ||
      candidate.label.toLowerCase().startsWith(needle),
  );
}

/**
 * Replaces the open "@query" at `mention.start` with "@handle " (trailing
 * space, so typing continues past the mention rather than into it) and
 * returns the new text plus where the caret lands. `handle` must be the
 * local part of the mentioned participant's address — see the module note
 * above — never a display name.
 */
export function insertMention(
  text: string,
  caret: number,
  mention: MentionQuery,
  handle: string,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  const inserted = `@${handle} `;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
