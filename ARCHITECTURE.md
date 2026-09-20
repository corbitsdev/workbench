# Architecture

Workbench is a client of [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, credentials, agent launch, and the
workflow runtime; Workbench is the hub composition, the web client, and a
handful of domain packages built on top.

## Services

- **`apps/hub`** — the Interchange hub server. It mounts stock
  `@intx/hub-api` routes (auth, tenants, principals, grants, workflow
  deploy/run) plus one composition block that adds Corbits libraries —
  `@corbits/mailbox` (mail), `@corbits/memory` (recall), `@corbits/artifacts`
  (files), `@corbits/cron` (scheduling), `@corbits/webhooks` (inbound
  webhook ingress) — and the remaining in-repo packages: `workflows`
  (author routes) and `agent-directory`. Credentials are stored through
  Interchange's own stock credential routes; nothing in this repo wraps
  or replaces them.
- **`apps/sidecar`** — a copy of Interchange's own sidecar. It executes
  workflow runs and agent turns on the hub's behalf; its few local deltas
  are listed in [VENDORED.md](VENDORED.md) with kill conditions.
- **`apps/web`** — the React client. On sign-in it converges its own
  tenant, workflow deployments, credentials, and grants over stock hub
  routes; the hub never seeds data for it.

## Tenancy

A workbench is a plain Interchange tenant — there is no separate
"workbench" tenancy layer. Every user gets a tenant on sign-up; a
principal is a person or an agent that can act inside one.

## Workbench mail

There is no chat-specific data model. A conversation is a thread in
`@corbits/mailbox`: `GET /me/inbox/threads` lists threads, `POST
/me/inbox/send` sends a message (as a person or, addressed as an agent
principal, as that agent). Fan-out, read state, and threading are the
library's; the hub only resolves the caller's tenant/principal and mailbox
address.

## Agents and workflows

Myra (`agents/myra`) is the only agent Workbench ships. Her tools are
`@intx/tools-mail` over her mail transport, `@intx/tools-posix` over her
working tree, and the `@corbits/artifacts`, `@corbits/memory` and
`@corbits/mcp` sidecar bundles. A bundle that calls back into the hub or
out to an MCP server never holds a secret: the web client stores a
tenant credential, the definition binds it to that one package and
requires its use on the deployer's authority, and the sidecar hands the
tool an origin-pinned mediated fetch. Myra writes further workflows and
agents as code; the person deploys them through the stock deploy route.

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
of it, an agent binds only what it needs, Myra's set is fixed.

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
