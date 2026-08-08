# @corbits/channel-digest-workflow

A single mail-triggered step meant to be deployed against a channel's
own timeline address. It relays whatever deterministic summary line its
trigger mail already carries — a message count, a timestamp, any line a
scheduler computed ahead of time — straight back into the channel,
mirroring how a channel host's reply becomes a channel mail post (see
`packages/chat/src/channel-workflow.ts` and `platform-adapter.ts`).

## What it does

One step, one agent, a system prompt that instructs relaying the
trigger's exact text with no additions, no commentary, no formatting of
its own. The deterministic content — the actual digest line — is
computed by whatever sends the trigger mail; this definition never
computes it itself, so its output is exactly as deterministic as its
input.

## Cost profile

**Pinned to `noop-inference` (default, zero cost):** deployed the same
way as `@corbits/heartbeat-workflow` — `inferencePreferences` pointed at
the hub's `noop-inference` endpoint (see `NOOP_MODEL_SOURCE` in
`packages/hub-client/src/seed.ts`). Every run resolves against a
constant, locally served SSE response, so running this on a tight
schedule costs nothing. The trade-off: `noop-inference` always replies
with empty text by design (see its header comment), so under this pin
no visible digest line is actually posted — the run still proves the
scheduling and channel-mail-posting paths stay alive, just without
visible output.

**Pinned to a real catalog model:** point `inferencePreferences` at any
configured model instead, and the relayed digest line is posted for
real, at that model's ordinary per-turn cost (a single short completion
per trigger — a few dozen tokens, not a real "reasoning" turn).

## Usage

```ts
import {
  buildChannelDigestWorkflow,
  serializeChannelDigestWorkflow,
} from "@corbits/channel-digest-workflow";

const definition = buildChannelDigestWorkflow({
  triggerAddress: "channel-digest@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "noop" }],
  turnTimeoutMs: 60_000,
});

const json = serializeChannelDigestWorkflow(definition);
```

Seeded by default for every tenant — see `DEFAULT_WORKFLOWS` in
`packages/hub-client/src/seed.ts`.
