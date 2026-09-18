# Architecture

Workbench is a client of [Interchange](https://github.com/faremeter/interchange).
Interchange owns identity, tenancy, credentials, agent launch, and the
workflow runtime; Workbench is the hub composition, the web client, and a
handful of domain packages built on top.

## Services

- **`apps/hub`** — the Interchange hub server. It mounts stock
  `@intx/hub-api` routes (auth, tenants, principals, grants, workflow
  deploy/run) plus one composition block that adds Corbits libraries —
  `@corbits/mailbox` (chat), `@corbits/memory` (recall), `@corbits/artifacts`
  (files), `@corbits/cron` (scheduling) — and the remaining in-repo
  packages: `connections` (credential catalog and OAuth), `webhook-triggers`
  (inbound webhook ingress), `workflows` (author routes), and
  `agent-directory`.
- **`apps/sidecar`** — a byte-for-byte copy of Interchange's own sidecar.
  It executes workflow runs and agent turns on the hub's behalf; Workbench
  makes no local changes to it.
- **`apps/web`** — the React client. On sign-in it converges its own
  tenant, workflow deployments, credentials, and grants over stock hub
  routes; the hub never seeds data for it.

## Tenancy

A workbench is a plain Interchange tenant — there is no separate
"workbench" tenancy layer. Every user gets a tenant on sign-up; a
principal is a person or an agent that can act inside one.

## Chat is mail

There is no chat-specific data model. A conversation is a thread in
`@corbits/mailbox`: `GET /me/inbox/threads` lists threads, `POST
/me/inbox/send` sends a message (as a person or, addressed as an agent
principal, as that agent). Fan-out, read state, and threading are the
library's; the hub only resolves the caller's tenant/principal and mailbox
address.

## Agents and workflows

Myra (`agents/myra`) is the only agent Workbench ships. There is no
workflow catalog to browse — Myra creates a workflow, tool, or skill
dynamically, as code, when a job needs one, and deploys it through the
stock workflow-deploy route. `tools/*` and `skills/*` are ordinary
`@corbits/*` packages an agent can pin.

## Data

Custom tables — `connections`, `webhook-triggers`, `agent-directory`, and
so on — live on their own Postgres schema, each with foreign keys back to
Interchange's `tenant`/`principal` tables in `public`. See
[docs/package-migrations.md](docs/package-migrations.md) for how a
package's own migrations are written and applied. Anything Interchange
already does natively is deleted rather than kept as a parallel path.

## Vendoring

Interchange capabilities not yet published to npm are vendored
byte-for-byte under `vendor/intx`, tracked with a kill date in
[VENDORED.md](VENDORED.md). The upstream repository is never modified.
