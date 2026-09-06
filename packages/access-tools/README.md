# @corbits/access-tools

Myra's principal and grant tools — a thin wrapper over the tenant's real
principal and grant rows, gated by Interchange's own grant-store
authorization (`@intx/authz`), never a reimplementation of it. Lets an
agent see who exists in its tenant and, once a human approves, grant or
revoke scoped access for the specialist agents it stands up.

`list_principals` lists every principal (user, agent, or workflow run)
in the calling agent's tenant, with its id, kind, and status, so a grant
can target the right principal id.

`list_grants` lists grants in the tenant, optionally filtered by
`principalId` or `resource`, so an agent can see what a principal
already has before granting more, or find the grant id `revoke_access`
needs.

`grant_access` grants a principal one or more actions on a resource
string (e.g. `read` on `workflow-run:*`). Declared `approval: "ask"` —
a human must approve the specific principal/resource/actions triple
before anything is written.

`revoke_access` revokes a previously created grant by its id. Also
declared `approval: "ask"`.

See `./src/routes.ts` for the workflow-run-authenticated hub-side
routes these tools call, mounted at `/api/workflow-access`.
