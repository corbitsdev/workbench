// A room mail send has no way to hand off between agents: the hub only
// delivers to run addresses, which only the client knows (a room's
// Participants panel already reads them off the deployment/run listing).
// Appending them as a trailing block on every room send gives every agent
// in the room everyone else's address, so one agent can mail another
// directly. Agent-to-agent mail goes run to run and never lands in the
// person's mailbox on its own, so the block also carries the person's own
// address and a line telling agents to copy it on any handoff — the mail
// tools have no `cc` field, so that means naming it as another `to`
// recipient. `stripRoster` is the inverse, used only to keep the block out
// of what a person sees echoed back as their own sent message.

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
  const addresses = people.map((entry) => entry.address).join(", ");
  // The subject clause is load-bearing: a mail with an empty Subject ends
  // the receiving agent's run today.
  return `Copy ${addresses} in \`to\` on any mail you send another participant, so they can follow along, and give every mail a short subject.`;
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
