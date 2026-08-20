# @corbits/commands

The global "/" and "@" command system for channels: a registry of
`{name, description, argumentHint?, handler}` commands, the grammar that
parses `/name args` and `@name args` off a raw message string, dispatch
that resolves and runs a parsed invocation, a built-in registrar that turns
a tenant's workflow definitions into commands, and the Hono routes that
list and execute them.

UI-free by design: `CommandListing` is exactly the data an autocomplete
dropdown needs (name, description, argumentHint) — the dropdown itself is
a `react-ui`/`chat-ui` concern, never built here.

## Composition with @intx/*

Routes are built on `@intx/hub-api`'s `TenantEnv` and `RequireGrant`
convention only — this package otherwise has no platform dependency; it
knows nothing about folded runs, channels, or storage. Workflow invocation
is reached only through the two narrow seams a host (today, only
`@corbits/chat`) injects: listing invitable definitions and starting one
against a channel, keeping this package host-agnostic.

## Key modules

- `src/registry.ts` — `createCommandRegistry`: the `CommandRegistry`,
  `CommandDefinition`, and `CommandPlugin` types.
- `src/grammar.ts` — `parseSlashCommand`/`parseAtCommand`: `PREFIX + NAME(
SPACE ARGS)?` parsing; each command's own handler parses its `args`
  string, the grammar never does.
- `src/dispatch.ts` — `dispatchSlashCommand`/`dispatchAtCommand`/`resolveAtCommand`:
  resolves a parsed invocation against the registry and runs it.
- `src/workflow-commands.ts` — `createWorkflowCommandPlugin`: the built-in
  registrar exposing every invitable workflow definition as a command.
- `src/routes.ts` — `createCommandRoutes`: `GET` (listing) and execute
  routes for callers that want a command's result without posting into a
  channel's timeline.

## Running tests

```
cd packages/commands && bun test
```

No drizzle suite; no `DATABASE_URL` needed.
