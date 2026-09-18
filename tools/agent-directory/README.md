# @corbits/agent-directory-tools

Myra's manager tool bundle: `list_agents`, `create_agent`, and
`message_agent`, as an `@intx/agent` tool factory.

Every call reaches stock Interchange routes with the workflow run's own
bearer credential — no workbench-specific mount:

- `list_agents` reads `GET /api/tenants/:t/assets?kind=workflow`, keeping
  the `agent-<slug>-source` assets a created agent's deploy names, and
  derives each one's live mail address from its slug and the tenant's
  domain.
- `create_agent` renders a single-step, mail-triggered workflow
  definition, ensures its source asset, pushes it over the asset's git
  smart-HTTP remote, resolves the tenant's own catalog offerings, and
  deploys through `POST /api/tenants/:t/workflows/deployments` — the same
  pipeline the web app's hand-authored create-agent panel runs.
- `message_agent` sends a mail-shaped message to another agent's address
  through the stock mailbox, `POST /api/tenants/:t/mailbox/me/inbox/send`.

Creation is free (no approval key): a new definition plus its deploy, not
a capability grant.
