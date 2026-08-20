// A workbench's live "who's here" roster, driven off the same `/stream`
// connection as every other live update (CL-6328) — never a second
// connection or an HTTP heartbeat poll. `chat.presence.snapshot` seeds the
// roster the moment the stream opens; `chat.presence` deltas
// (`packages/chat/src/workbench-presence.ts`) keep it current from there.
// The one thing the stream can't tell this reader — that a backgrounded
// tab is still theirs — is `POST /workbenches/:id/presence`'s job (see
// `pingWorkbenchPresence` in `./api.ts`), called on real activity rather
// than polled on an interval.

import { useEffect, useState } from "react";

export type PresenceRosterEntry = {
  readonly principalId: string;
  readonly lastActiveAt: string;
};

/** Parses a `chat.presence` SSE payload at the trust boundary — the same
 * narrow-parse idiom `typing-indicator.tsx`'s `parseTypingEvent` uses. */
export function parsePresenceEvent(
  data: unknown,
): (PresenceRosterEntry & { readonly state: "online" | "offline" }) | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const principalId = record.principalId;
  const state = record.state;
  const lastActiveAt = record.lastActiveAt;
  if (
    typeof principalId !== "string" ||
    typeof lastActiveAt !== "string" ||
    (state !== "online" && state !== "offline")
  ) {
    return null;
  }
  return { principalId, state, lastActiveAt };
}

/** Parses a `chat.presence.snapshot` SSE payload — the one-time roster a
 * freshly opened stream is handed before any delta. */
export function parsePresenceSnapshotEvent(
  data: unknown,
): readonly PresenceRosterEntry[] | null {
  if (typeof data !== "object" || data === null) return null;
  const members = (data as Record<string, unknown>).members;
  if (!Array.isArray(members)) return null;
  const parsed: PresenceRosterEntry[] = [];
  for (const entry of members) {
    if (typeof entry !== "object" || entry === null) return null;
    const principalId = (entry as Record<string, unknown>).principalId;
    const lastActiveAt = (entry as Record<string, unknown>).lastActiveAt;
    if (typeof principalId !== "string" || typeof lastActiveAt !== "string") {
      return null;
    }
    parsed.push({ principalId, lastActiveAt });
  }
  return parsed;
}

/**
 * The roster's whole state machine, pure and testable without mounting
 * anything — mirrors `typing-indicator.tsx`'s `nextTypingState`. A
 * snapshot replaces the roster outright; a delta upserts an "online"
 * member or drops an "offline" one; any other event leaves it untouched.
 */
export function nextPresenceRoster(
  current: readonly PresenceRosterEntry[],
  event: { readonly eventType: string; readonly data: unknown },
): readonly PresenceRosterEntry[] {
  if (event.eventType === "chat.presence.snapshot") {
    const parsed = parsePresenceSnapshotEvent(event.data);
    return parsed ?? current;
  }
  if (event.eventType === "chat.presence") {
    const parsed = parsePresenceEvent(event.data);
    if (parsed === null) return current;
    if (parsed.state === "offline") {
      return current.filter((member) => member.principalId !== parsed.principalId);
    }
    const existingIndex = current.findIndex(
      (member) => member.principalId === parsed.principalId,
    );
    const entry: PresenceRosterEntry = {
      principalId: parsed.principalId,
      lastActiveAt: parsed.lastActiveAt,
    };
    if (existingIndex === -1) return [...current, entry];
    return current.map((member, index) =>
      index === existingIndex ? entry : member,
    );
  }
  return current;
}

/**
 * Owns the who's-here roster end to end: feed it every stream event
 * (`chat-workspace.tsx` already sees them all) and it tracks who's live.
 * `workbenchId` resets the roster on a workbench switch — a snapshot from
 * the workbench just left means nothing here.
 */
export function useWorkbenchPresenceRoster(workbenchId: string | null): {
  readonly roster: readonly PresenceRosterEntry[];
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
} {
  const [roster, setRoster] = useState<readonly PresenceRosterEntry[]>([]);

  useEffect(() => {
    setRoster([]);
  }, [workbenchId]);

  function handleStreamEvent(eventType: string, data: unknown) {
    setRoster((current) => nextPresenceRoster(current, { eventType, data }));
  }

  return { roster, handleStreamEvent };
}
