# @corbits/credential-expiry-workflow

A mail-triggered workflow that checks this tenant's credentials on each
trigger and mails a reconnect notice for any credential that is `active`
but past its own `expiresAt`. `@corbits/cron` delivers a tick mail once
a day. Replaces the hub-owned periodic loop
`apps/hub/src/credential-expiry-sweep.ts` (CL-8181): the same decision
runs as a deployed Routine instead of inside the hub process.

## What it does

One step, one agent: it calls `credential_expiry_check` (this package's
own read-only tool) exactly once. That tool reads the stock
`GET /api/tenants/:tenantId/credentials` (paired with `/providers` for
display names) with the run's own bearer, and
`findDueCredentialExpiries` (`./src/decide.ts`) decides which rows are
`active` and already past their own `expiresAt`. The step's reply is
the reconnect notice itself — one sentence when nothing is due, or a
short notice naming each due credential — delivered as mail by the host
the same way `@corbits/heartbeat-workflow` and
`@corbits/workbench-digest-workflow` deliver theirs. No separate
mail-send tool exists in this repo yet.

## Scope note

The hub sweep this replaces also refreshed `mcp:<slug>` OAuth tokens in
place before ever mailing anyone (CL-6207). That native-refresh path
mutates a stored credential's secret directly, which no stock tenant
route exposes to a workflow run, so it stays a hub concern and is not
carried over here — this workflow only reads and reports.

## Usage

```ts
import {
  buildCredentialExpiryWorkflow,
  serializeCredentialExpiryWorkflow,
} from "@corbits/credential-expiry-workflow";

const definition = buildCredentialExpiryWorkflow({
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-haiku" }],
  turnTimeoutMs: 60_000,
});

const json = serializeCredentialExpiryWorkflow(definition);
```

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean.

## Deploy from the npm registry

Once published, deploy this workflow definition to a tenant by name and
version pin:

```
POST /api/tenants/:id/workflows/deployments
{
  "source": { "kind": "registry", "registry": "npm" },
  "entry": "./src/index.ts",
  "pin": "@corbits/credential-expiry-workflow@0.0.1",
  "sourceOfferingIds": ["<catalog offering id>", ...],
  "defaultSourceOfferingId": "<catalog offering id>"
}
```

`entry` is the package's `interchange.workflow` module path; `pin` is
`"@corbits/credential-expiry-workflow@0.0.1"` or a semver range on the
same name. The hub installs, probes, gates, and freezes the definition
from the registry tarball before creating the deployment.
