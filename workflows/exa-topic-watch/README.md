# exa-topic-watch

A scheduled web topic watch. Each run reads one topic from the message
that started it, searches the live web, and publishes a short digest of
what moved — held for a human's approval before anything is saved.

Ported from the OG gtm-workbench's `exa-topic-watch` (CL-6349).

## The run

One reasoning turn:

1. Read the topic off the triggering mail.
2. Discover and call the web-search tools on the connected Exa MCP server
   (`mcp_list_tools`, then `mcp_read` — read-only, no approval).
3. Write the digest: **What moved**, **Takeaways**, **Worth a closer look**.
4. Call `exa_topic_watch_finalize` once. That call is `approval: "ask"`:
   the run suspends until a human approves, then the digest is persisted
   as a Library artifact.

A quiet week still finalizes, with `outcome: "status-note"` — so every
fire leaves a visible trace instead of silence.

## What this port changed, and why

- **Six steps folded into one.** Five of the OG's steps were native
  `action` primitives. This repo's production host leaves `invokeAction`
  undefined, so an `action` step would deploy as something nothing can
  dispatch. Folding also deleted the OG's `exa_topic_watch_prepare_search`
  rename tool outright: an agent names a search tool's arguments itself.
- **Exa through the MCP preset**, not a bespoke `@workbench/tools-exa`
  package. `@corbits/mcp-tools` is one of the few tool packages this repo
  publishes to its own registry, so a pin on it resolves at deploy time.
  The `mcp:exa` credential handle is dynamic tenant data, so the host
  supplies its binding (`apps/hub/src/mcp-credential-bindings.ts`) — this
  definition declares none.
- **Publishing is approval-gated.** The OG persisted through an ungated
  `write_artifact` action. Every external side effect here sits behind
  human approval (`AGENTS.md`).
- **The trigger is the topic.** The OG parked on `awaitSignal("intake")`.
  Workbench collects the topic on the routine before launch and delivers
  it as the first-turn mail; a gate nobody fulfils would hang the run.

## Known gaps

- `toolPackagePins` resolution is proven for single-step definitions only.
  This definition is single-step by design, so it stays inside what the
  deploy path has actually run.
- The digest has no memory of the previous run. "What moved since last
  time" is the model reading publication dates, not a stored watermark.

## Registration

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable: true`
(it is built to run on a schedule) and not seeded by default: it needs an
Exa connection not every tenant has.

## Deploy from the npm registry

Once published, deploy this workflow definition to a tenant by name and
version pin:

```
POST /api/tenants/:id/workflows/deployments
{
  "source": { "kind": "registry", "registry": "npm" },
  "entry": "./src/index.ts",
  "pin": "@corbits/exa-topic-watch-workflow@0.0.1",
  "sourceOfferingIds": ["<catalog offering id>", ...],
  "defaultSourceOfferingId": "<catalog offering id>"
}
```

`entry` is the package's `interchange.workflow` module path; `pin` is
`"@corbits/exa-topic-watch-workflow@0.0.1"` or a semver range on the same name. The hub
installs, probes, gates, and freezes the definition from the registry
tarball before creating the deployment.
