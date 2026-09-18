// Mirrored from packages/chat/src (see docs/chat-wire-contract.md).

// Reading tolerates a bare address string (pre-rollout data) and upgrades it
// to a record; writing always produces records, never bare strings.

import { type } from "arktype";
import { localPartOf } from "./agent-address";

export interface ParticipantRecord {
  readonly address: string;
  readonly handle: string;
}

const ParticipantRecordSchema = type({
  address: "string",
  handle: "string",
});

/** The permissive shape a single `chat/participants` entry may carry on
 * the wire: a bare address string, or an already-upgraded record. */
export const ParticipantEntry = type("string").or(ParticipantRecordSchema);

/** The full `chat/participants` setting value's permissive wire shape. */
export const ParticipantsSetting = ParticipantEntry.array();

function parseParticipantEntry(entry: unknown): ParticipantRecord {
  if (typeof entry === "string") {
    return { address: entry, handle: localPartOf(entry) };
  }
  const result = ParticipantRecordSchema(entry);
  if (result instanceof type.errors) {
    throw new Error(`invalid participant entry: ${result.summary}`);
  }
  return result;
}

// Tolerant of a workbench with a mix of pre- and post-rollout entries.
export function parseParticipants(raw: unknown): ParticipantRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseParticipantEntry);
}

// Falls back to the address's local part when the name yields nothing
// usable (e.g. all punctuation).
export function handleFromName(name: string, fallbackAddress: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : localPartOf(fallbackAddress);
}

// "echo" becomes "echo-2", then "echo-3" — the first suffix not taken.
export function dedupeHandle(handle: string, taken: ReadonlySet<string>): string {
  if (!taken.has(handle)) return handle;
  let suffix = 2;
  while (taken.has(`${handle}-${suffix}`)) suffix += 1;
  return `${handle}-${suffix}`;
}

// Returns the existing list by identity on a same-address retry, so a
// caller can tell "already present" from "appended".
export function addParticipant(
  existing: readonly ParticipantRecord[],
  address: string,
  desiredHandle: string,
): ParticipantRecord[] {
  if (existing.some((participant) => participant.address === address)) {
    return existing as ParticipantRecord[];
  }
  const taken = new Set(existing.map((participant) => participant.handle));
  const handle = dedupeHandle(desiredHandle, taken);
  return [...existing, { address, handle }];
}

// Returns the same array reference when the address names no participant,
// so a caller can tell "nothing changed" by identity.
export function removeParticipant(
  existing: readonly ParticipantRecord[],
  address: string,
): ParticipantRecord[] {
  if (!existing.some((participant) => participant.address === address)) {
    return existing as ParticipantRecord[];
  }
  return existing.filter((participant) => participant.address !== address);
}
