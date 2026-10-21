# Architecture

Workbench is a client of [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, credentials, agent launch, and the
workflow runtime; Workbench is the hub composition, the web client, and a
handful of domain packages built on top.

## Services

- **`apps/hub`** — the Interchange hub server. It mounts stock
  `@intx/hub-api` routes (auth, tenants, principals, grants, workflow
  deploy/run) plus one composition block (`apps/hub/src/server.ts`) that adds
  Corbits libraries: `@corbits/mailbox` (mail), `@corbits/memory` (recall),
  `@corbits/artifacts` (files), `@corbits/cron` (scheduling),
  `@corbits/webhooks` (inbound webhook ingress), `@corbits/mcp` (MCP catalog
  discovery), `@corbits/agent-token` (run-scoped bearer tokens for deployed
  agents), and `@corbits/oauth-core` (loopback OAuth login and token refresh
  for Codex and xAI). Credentials are stored through Interchange's own stock
  credential routes; nothing in this repo wraps or replaces them.
- **`apps/sidecar`** — a copy of Interchange's own sidecar. It executes
  workflow runs and agent turns on the hub's behalf; its local deltas
  are listed in [VENDORED.md](VENDORED.md) with kill conditions.
- **`apps/web`** — the React client. On sign-in it converges its own
  tenant, workflow deployments, credentials, and grants over stock hub
  routes; the hub never seeds data for it.

## Tenancy

A workbench is a plain Interchange tenant — there is no separate
"workbench" tenancy layer. Every user gets a root workspace tenant on
sign-up, and creating a workbench creates a child tenant underneath it; a
principal is a person or an agent that can act inside one.

## Workbench mail

There is no chat-specific data model. A workbench's conversation is its own
child tenant's mailbox in `@corbits/mailbox` (`/api/tenants/:id/mailbox/me/inbox/...`).
`sendToWorkbench` fans out to every live agent in the workbench unless an
`@Name` mention narrows the recipient list, and appends a trailing
`Participants:` roster (stripped when rendering a person's echoed-back
message) so agents know each participant's run address and copy the person on
handoffs. A person's address (`<userId>@<domain>`) is lowercased on both client
and hub so small models that lowercase addresses on reply still match the
thread's participant; mailbox delivery matches the local part
case-insensitively.

## Agents, workflows, and scheduling

`packages/worker` is the one harness a bench's worker, and any agent
Workbench creates, deploys on. Its tools are `@intx/tools-mail` over the
mail transport, `@intx/tools-posix` over the working tree, and the `@corbits/artifacts`, `@corbits/memory` and
`@corbits/mcp` sidecar bundles. A bundle that calls back into the hub or
out to an MCP server never holds a secret: the web client stores a
tenant credential, the definition binds it to that one package and
requires its use on the deployer's authority, and the sidecar hands the
tool an origin-pinned mediated fetch. The worker writes further workflows and
agents as code; the person deploys them through the stock deploy route.

Scheduled workflows use `@corbits/cron` (`/api/tenants/:id/cron`), targeting a
workflow by its source asset's definition name so schedules survive redeploys.
At fire time the ticker resolves the definition name to the live anchor run
and delivers via the stock mail trigger route (`POST /workflows/:runId/mail`,
which Run Now also calls directly). If no anchor run is live between runs, the
schedule waits (`waitingSince`) and resumes on the next delivery; it stops
permanently (`stoppedReason: "agent_deleted"`) only when the definition itself
is deleted.

## Tool visibility

Interchange sends a model every tool on every turn. Workbench keeps that
affordable with `@corbits/deferred-tools`: a custom Interchange director
(shipped in the agent's own package via `interchange.directors`) that
sends the model its visible tools plus `tool_search`, and appends a whole
namespace of deferred tools once a search matches it. The list only grows
within a context, in surfacing order, so each turn's tools block is a
prefix of the next and prompt caching keeps hitting; compaction is the
only reset point. Grants are unaffected: authorization checks every call
against the full definition.

## MCP

An MCP server is a tenant credential on the streamable-HTTP provider,
with its discovered tool catalog stored in the credential's metadata.
The hub mounts `@corbits/mcp`'s discovery route so an OAuth-protected
catalog is read server-side; a deploy reads the stored catalog and never
touches the network. Each remote tool becomes an agent tool named
`<server>.<tool>`, its own grant resource, ask-gated unless the server
marks it read-only. The catalog belongs to the workspace; a workbench binds all
of it, an agent binds only what it needs, the worker's set is fixed.

## Data

Custom tables — `agent-directory` and so on — live
on their own Postgres schema, each with foreign keys back to
Interchange's `tenant`/`principal` tables in `public`. Each package ships
one idempotent migration, which the hub applies itself at boot. Anything
Interchange already does natively is deleted rather than kept as a
parallel path.

## Vendoring

Interchange capabilities not yet published to npm are vendored
byte-for-byte under `vendor/intx`, tracked with a kill date in
[VENDORED.md](VENDORED.md). The upstream repository is never modified.
