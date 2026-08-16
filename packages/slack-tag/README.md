# @corbits/slack-tag

Slack mount composition for workbench's channel/tenancy machinery: binds a
Slack channel to a workbench channel, auto-provisions Interchange
principals for Slack authors on first contact, and routes mentions and
thread messages through the existing chat platform — the same path a
human's message from the web UI takes.

## How it composes with Interchange

- `dispatch.ts`'s `mountWorkbenchSlack` wires the vendored
  `corbits-tag/slack`'s `mountSlackTag` (signature verification, event
  normalization) together with this package's own principal resolver and
  channel binding into one dispatch flow — the Slack-specific mechanics
  live in `corbits-tag`, never reimplemented here.
- `principal-resolver.ts`'s auto-provisioning lifts the
  `createAutoProvisionPrincipalResolver` pattern from Scout's
  `packages/agent-dock/src/tag-mount.ts`, riding `corbits-tag/interchange`'s
  own product-agnostic `createPrincipalResolver`/`provisionPrincipal`.
- `thread-state.ts` resolves a Chat SDK `StateAdapter` (`chat`,
  `@chat-adapter/state-memory`) for `corbits-tag/slack`'s own thread
  subscription/dedup/lock state, falling back to an in-memory adapter if
  the durable backend is unreachable at mount time.
- Channel provisioning and message delivery are injected
  (`deps.provisionChannel`, `deps.sendMessage`) from the host's own
  `@corbits/chat` composition — this package never launches a channel
  host or drives inference itself.

## Key modules

- `dispatch.ts` — `mountWorkbenchSlack`, the composition root.
- `channel-binding.ts` — resolve-or-create the one workbench channel a
  Slack channel is bound to.
- `principal-resolver.ts` — auto-provision an Interchange principal for a
  first-contact Slack author; channel membership is itself the
  authorization.
- `store.ts` / `schema.ts` / `migrations.ts` — the `slack_tag` Postgres
  schema and its one table, `slack_channel_binding`, keyed by
  `(tenant_id, slack_channel_id)`.
- `manifest.ts` — the Slack app manifest template, rendered per
  deployment origin.
- `reply-wait.ts` — waits for the channel host's next reply so it can be
  relayed back to Slack.

## Running tests

```
cd packages/slack-tag && bun test
```

No live database required — `store.test.ts` runs against the in-memory
binding store; no test in this package uses drizzle against a real
Postgres instance.
