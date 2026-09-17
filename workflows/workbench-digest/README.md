# @corbits/workbench-digest-workflow

A single mail-triggered step meant to be deployed against a workbench's
own timeline address. `@corbits/cron` delivers a tick mail on the
digest's schedule (daily at 09:00 UTC), and each tick relays a
deterministic summary line straight back into the workbench, mirroring
how a workbench host's reply becomes a workbench mail post (see
`packages/chat/src/workbench-workflow.ts` and `platform-adapter.ts`).

## What it does

One step, one agent, a system prompt that instructs relaying the
trigger's exact text with no additions, no commentary, no formatting of
its own. This package never computes the digest line itself, so its
output is exactly as deterministic as its input.

## Cost profile

**Pinned to `noop-inference` (default, zero cost):** deployed the same
way as `@corbits/heartbeat-workflow` — `inferencePreferences` pointed at
the hub's `noop-inference` endpoint (see
`packages/chat/src/noop-inference.ts`'s header comment). Every run resolves against a
constant, locally served SSE response, so running this on a tight
schedule costs nothing. The trade-off: `noop-inference` always replies
with empty text by design (see its header comment), so under this pin
no visible digest line is actually posted — the run still proves the
mail-trigger and workbench-mail-posting paths stay alive, just without
visible output.

**Pinned to a real catalog model:** point `inferencePreferences` at any
configured model instead, and the relayed digest line is posted for
real, at that model's ordinary per-turn cost (a single short completion
per trigger — a few dozen tokens, not a real "reasoning" turn).

## Usage

```ts
import {
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "@corbits/workbench-digest-workflow";

const definition = buildWorkbenchDigestWorkflow({
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "noop" }],
  turnTimeoutMs: 60_000,
});

const json = serializeWorkbenchDigestWorkflow(definition);
```

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable`, and
deployable through the catalog instantiate route (CL-7073) from
`CATALOG_WORKFLOWS` (CL-7074), not seeded by default onto every tenant.

## Deploy from the npm registry

Once published, deploy this workflow definition to a tenant by name and
version pin:

```
POST /api/tenants/:id/workflows/deployments
{
  "source": { "kind": "registry", "registry": "npm" },
  "entry": "./src/index.ts",
  "pin": "@corbits/workbench-digest-workflow@0.0.1",
  "sourceOfferingIds": ["<catalog offering id>", ...],
  "defaultSourceOfferingId": "<catalog offering id>"
}
```

`entry` is the package's `interchange.workflow` module path; `pin` is
`"@corbits/workbench-digest-workflow@0.0.1"` or a semver range on the same name. The hub
installs, probes, gates, and freezes the definition from the registry
tarball before creating the deployment.
