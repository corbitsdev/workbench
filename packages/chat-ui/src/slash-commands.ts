// Pure /-command logic for the composer: the catalog of commands this
// build can actually run today, detecting an in-progress command token,
// and filtering the catalog against what's been typed so far. No DOM, no
// side effects — actions live in composer.tsx, the only place with the
// workbench/host context a command's action needs.
//
// The catalog is deliberately short. `/thread` is out of scope (killed by
// owner decision — see command-palette-actions.ts's own note on "New
// thread"). `/status` and `/pin` have no backend or store behind them yet
// and are omitted rather than wired to a no-op — a command that appears
// in the popover promises a real action.

export type SlashCommandId =
  "invite" | "summarize" | "routine" | "agents" | "help";

export type SlashCommandSpec = {
  readonly id: SlashCommandId;
  readonly name: string;
  readonly description: string;
};

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    id: "invite",
    name: "/invite",
    description: "Invite an agent to this conversation",
  },
  {
    id: "summarize",
    name: "/summarize",
    description: "Ask this conversation's agent to summarize the thread",
  },
  {
    id: "routine",
    name: "/routine",
    description: "Create a new routine that delivers here",
  },
  {
    id: "agents",
    name: "/agents",
    description: "Open this conversation's agents settings",
  },
  { id: "help", name: "/help", description: "List available commands" },
];

export type SlashQuery = {
  /** Always 0 — a command only ever opens at the very start of the draft.
   * Kept for symmetry with `MentionQuery` and so callers never need to
   * special-case where the token being replaced begins. */
  readonly start: number;
  readonly query: string;
};

/**
 * Looks for an open "/command" token starting at the very beginning of the
 * draft — a "/" anywhere else in a message is just punctuation, never a
 * command — with the caret inside it and no whitespace since. Returns null
 * everywhere else, including once the token is closed by a space.
 */
export function activeSlashQuery(
  text: string,
  caret: number,
): SlashQuery | null {
  if (text.charAt(0) !== "/") return null;
  const upToCaret = text.slice(0, caret);
  if (!/^\/[\w-]*$/.test(upToCaret)) return null;
  return { start: 0, query: upToCaret.slice(1) };
}

/**
 * Commands whose id starts with the query, case-insensitively. An empty
 * query matches every command — the popover opens on a bare "/".
 */
export function filterSlashCommands(
  query: string,
): readonly SlashCommandSpec[] {
  const needle = query.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.id.startsWith(needle));
}
