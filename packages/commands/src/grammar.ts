// The command-invocation grammar shared by the "/" and "@" surfaces:
// `PREFIX + NAME( SPACE ARGS)?`. The name runs up to the first space;
// everything after that first space is the raw, untokenized remainder
// — each command's own handler is responsible for parsing its args,
// this grammar never does. Ported from corbits-code's slash grammar
// (`/NAME( ARGS)?`), generalized to a caller-supplied prefix so the
// same parse rule serves both `/name args` and `@name args`.

export interface ParsedCommand {
  readonly name: string;
  readonly args: string;
}

// A command name is a bare word — letters, digits, underscore, hyphen —
// the same shape the composer's own `activeSlashQuery` already commits
// to before it ever opens the popover. Anything else (a path like
// "/usr/local/bin", a URL, plain punctuation) is not a command attempt
// at all, so `parseWithPrefix` returns `undefined` for it rather than
// naming it an "unknown command" — that misfire used to swallow an
// ordinary message and answer it with a command error instead.
const NAME_PATTERN = /^[\w-]+$/;

function parseWithPrefix(
  text: string,
  prefix: string,
): ParsedCommand | undefined {
  if (!text.startsWith(prefix)) return undefined;
  const rest = text.slice(prefix.length);
  const spaceIndex = rest.indexOf(" ");
  const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
  if (!NAME_PATTERN.test(name)) return undefined;
  const args = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim();
  return { name, args };
}

/** Parses `/NAME( ARGS)?`, `undefined` when `text` does not start with
 * `/` or names nothing (a bare `/`). */
export function parseSlashCommand(text: string): ParsedCommand | undefined {
  return parseWithPrefix(text, "/");
}

/** Parses `@NAME( ARGS)?` — the same grammar, `@`-prefixed, used to
 * decide whether a workbench message's leading mention names a workflow
 * command rather than an already-invited agent participant. */
export function parseAtCommand(text: string): ParsedCommand | undefined {
  return parseWithPrefix(text, "@");
}
