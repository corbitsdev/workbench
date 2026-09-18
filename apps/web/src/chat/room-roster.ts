// A room mail send has no way to hand off between agents: the hub only
// delivers to run addresses, which only the client knows (a room's
// Participants panel already reads them off the deployment/run listing).
// Appending them as a trailing block on every room send gives every agent
// in the room everyone else's address, so one agent can mail another
// directly. `stripRoster` is the inverse, used only to keep the block out
// of what a person sees echoed back as their own sent message.

const ROSTER_HEADING = "Participants:";

export type RosterEntry = {
  readonly name: string;
  readonly address: string;
};

/** The trailing block marker, including the blank-line separator that
 * `stripRoster` looks for. */
function rosterBlock(entries: readonly RosterEntry[]): string {
  return [ROSTER_HEADING, ...entries.map((entry) => `${entry.name} <${entry.address}>`)].join("\n");
}

/** Appends a `Participants:` block listing every entry's name and address,
 * separated from the message by a blank line. A no-op with no entries. */
export function appendRoster(body: string, entries: readonly RosterEntry[]): string {
  if (entries.length === 0) return body;
  return `${body}\n\n${rosterBlock(entries)}`;
}

/** Removes a trailing `Participants:` block appended by `appendRoster`, so
 * a person's own sent message never shows it echoed back. A body with no
 * such block is returned unchanged. */
export function stripRoster(body: string): string {
  const marker = `\n\n${ROSTER_HEADING}\n`;
  const index = body.lastIndexOf(marker);
  return index === -1 ? body : body.slice(0, index);
}
