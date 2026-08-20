// Workbench participant records: the settings-backed source of mention
// handles. `chat/participants` (see `routes.ts`'s `ChatNamespaceSchemas`)
// holds `ParticipantRecord[]` — an address plus the short,
// unique-within-workbench handle a mention actually types (`@echo`), never
// the unusable instance-id local part (`@ins_cd03d8e3...`). Reading
// tolerates a bare address string too — a participant seeded before this
// record shape existed, or a caller PATCHing `chat/participants` with
// plain addresses — always upgrading it to a record on the way out (its
// handle defaults to the address's own local part); writing always
// produces records, never bare strings.

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
    throw new Error(`invalid chat participant entry: ${result.summary}`);
  }
  return result;
}

/**
 * Parses a whole `chat/participants` setting value into records,
 * tolerant of the mixed shape a workbench written before and after this
 * rollout might carry: some entries bare strings, some already records.
 * Anything other than an array is treated as no participants at all.
 */
export function parseParticipants(raw: unknown): ParticipantRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseParticipantEntry);
}

/**
 * A short, word-safe handle derived from a workflow definition's name —
 * e.g. "Echo Bot" -> "echo-bot" — lowercased, non-alphanumeric runs
 * collapsed to a single hyphen, and leading/trailing hyphens trimmed.
 * Falls back to the given address's own local part when the name yields
 * nothing usable (e.g. a name of all punctuation, or empty).
 */
export function handleFromName(name: string, fallbackAddress: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : localPartOf(fallbackAddress);
}

/**
 * De-duplicates a candidate handle against the handles already in use in
 * a workbench: "echo" becomes "echo-2", then "echo-3", etc. — the first
 * suffix not already taken.
 */
export function dedupeHandle(
  handle: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(handle)) return handle;
  let suffix = 2;
  while (taken.has(`${handle}-${suffix}`)) suffix += 1;
  return `${handle}-${suffix}`;
}

/**
 * Appends a new participant to an existing record list, de-duplicating
 * the desired handle against every handle already in the workbench.
 */
export function addParticipant(
  existing: readonly ParticipantRecord[],
  address: string,
  desiredHandle: string,
): ParticipantRecord[] {
  const taken = new Set(existing.map((participant) => participant.handle));
  const handle = dedupeHandle(desiredHandle, taken);
  return [...existing, { address, handle }];
}

/**
 * Drops a participant from an existing record list by address — the
 * inverse of `addParticipant`. Returns the same array reference when
 * the address names no participant, so a caller can tell "nothing
 * changed" apart from "removed the last matching entry" by identity.
 */
export function removeParticipant(
  existing: readonly ParticipantRecord[],
  address: string,
): ParticipantRecord[] {
  if (!existing.some((participant) => participant.address === address)) {
    return existing as ParticipantRecord[];
  }
  return existing.filter((participant) => participant.address !== address);
}
