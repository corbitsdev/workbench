// The one dispatch path every surface that runs a command goes
// through: parse, resolve, run — loud ("Unknown command: /x") on a
// miss rather than silently dropping the invocation. Shared by the
// workbench message pipeline (`@corbits/chat`'s intercept of a leading
// "/" or "@name") and the direct execute route in `./routes`, so the
// two can never answer an unknown command differently.
import {
  parseAtCommand,
  parseSlashCommand,
  type ParsedCommand,
} from "./grammar";
import type {
  CommandContext,
  CommandRegistry,
  CommandResult,
} from "./registry";

function unknownCommandResult(name: string, prefix: "/" | "@"): CommandResult {
  return { type: "message", text: `Unknown command: ${prefix}${name}` };
}

async function runParsed(
  registry: CommandRegistry,
  parsed: ParsedCommand,
  prefix: "/" | "@",
  ctx: CommandContext,
): Promise<CommandResult> {
  const command = await registry.getCommand(parsed.name, ctx.tenantId);
  if (command === undefined) return unknownCommandResult(parsed.name, prefix);
  return command.handler(parsed.args, ctx);
}

/** Dispatches a `/name args` invocation. `undefined` when `text` is not
 * slash-shaped at all — the caller's cue to treat it as an ordinary
 * message instead. */
export async function dispatchSlashCommand(
  registry: CommandRegistry,
  text: string,
  ctx: CommandContext,
): Promise<CommandResult | undefined> {
  const parsed = parseSlashCommand(text);
  if (parsed === undefined) return undefined;
  return runParsed(registry, parsed, "/", ctx);
}

/**
 * Resolves a leading `@name` against the registry without running it —
 * the caller (the workbench message pipeline) uses this to decide whether
 * an `@mention` names a workflow command at all before it commits to
 * the command path instead of the ordinary agent-mention fan-out.
 * `undefined` when `text` is not `@`-shaped, or `name` resolves to no
 * registered command (including the ordinary case of an `@mention` of
 * an existing agent participant, which is never itself a command).
 */
export async function resolveAtCommand(
  registry: CommandRegistry,
  text: string,
  tenantId: string,
): Promise<ParsedCommand | undefined> {
  const parsed = parseAtCommand(text);
  if (parsed === undefined) return undefined;
  const command = await registry.getCommand(parsed.name, tenantId);
  return command === undefined ? undefined : parsed;
}

/** Dispatches an already-resolved `@name args` invocation — the
 * counterpart to `resolveAtCommand`, run only once the caller has
 * confirmed `name` is not an existing agent participant's handle. */
export async function dispatchAtCommand(
  registry: CommandRegistry,
  text: string,
  ctx: CommandContext,
): Promise<CommandResult | undefined> {
  const parsed = parseAtCommand(text);
  if (parsed === undefined) return undefined;
  return runParsed(registry, parsed, "@", ctx);
}
