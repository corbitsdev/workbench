// See docs/chat-mail-threading.md for the roster mechanism. `stripRoster`
// is the inverse, used to keep the block out of a person's echoed-back sent
// message.

const ROSTER_HEADING = "Participants:";

export type RosterEntry = {
  readonly name: string;
  readonly address: string;
  readonly kind: "person" | "agent";
};

/** The trailing block marker, including the blank-line separator that
 * `stripRoster` looks for. */
function rosterBlock(entries: readonly RosterEntry[]): string {
  return [ROSTER_HEADING, ...entries.map((entry) => `${entry.name} <${entry.address}>`)].join("\n");
}

/** The trailing instruction naming every person in the roster, so an agent
 * knows to copy them on a handoff to another participant. `undefined` when
 * the roster has no person entry (there is nobody to copy). */
function ccInstruction(entries: readonly RosterEntry[]): string | undefined {
  const people = entries.filter((entry) => entry.kind === "person");
  if (people.length === 0) return undefined;
  const quoted = people.map((entry) => `"${entry.address}"`).join(", ");
  // The list shape and the subject clause are both load-bearing: a
  // comma-joined `to` string is dropped as one bad recipient, and a mail
  // with an empty Subject ends the receiving agent's run today.
  return `When you mail another participant, pass \`to\` as a list with them and the person, e.g. \`to: ["<their address>", ${quoted}]\`, never one comma-joined string, and give every mail a short subject.`;
}

/** Appends a `Participants:` block listing every entry's name and address,
 * plus a `cc` instruction naming any person in the roster, separated from
 * the message by a blank line. A no-op with no entries. */
export function appendRoster(body: string, entries: readonly RosterEntry[]): string {
  if (entries.length === 0) return body;
  const instruction = ccInstruction(entries);
  return [
    body,
    "",
    rosterBlock(entries),
    ...(instruction !== undefined ? ["", instruction] : []),
  ].join("\n");
}

/** Removes a trailing `Participants:` block appended by `appendRoster`, so
 * a person's own sent message never shows it echoed back. A body with no
 * such block is returned unchanged. */
export function stripRoster(body: string): string {
  const marker = `\n\n${ROSTER_HEADING}\n`;
  const index = body.lastIndexOf(marker);
  return index === -1 ? body : body.slice(0, index);
}
