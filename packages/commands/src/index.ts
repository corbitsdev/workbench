// `@corbits/commands`: the global "/" and "@" command system for
// channels. A registry of `{name, description, argumentHint?, handler}`
// commands, the grammar that parses `/name args` and `@name args` off a
// raw message string, dispatch that resolves and runs a parsed
// invocation, the built-in registrar that turns a tenant's workflow
// definitions into commands, and the Hono routes that list and execute
// them.
//
// UI-free by design: `CommandListing` is exactly the data an
// autocomplete dropdown needs (name, description, argumentHint) — the
// dropdown itself is a `react-ui`/`chat-ui` concern, never built here.
export { createCommandRegistry } from "./registry";
export type {
  CommandContext,
  CommandDefinition,
  CommandListing,
  CommandPlugin,
  CommandRegistry,
  CommandResult,
} from "./registry";

export { parseAtCommand, parseSlashCommand } from "./grammar";
export type { ParsedCommand } from "./grammar";

export {
  dispatchAtCommand,
  dispatchSlashCommand,
  resolveAtCommand,
} from "./dispatch";

export { createWorkflowCommandPlugin } from "./workflow-commands";
export type {
  StartedWorkflowCommand,
  WorkflowCommandDeps,
  WorkflowCommandTarget,
} from "./workflow-commands";

export { createCommandRoutes } from "./routes";
export type { CreateCommandRoutesDeps } from "./routes";
