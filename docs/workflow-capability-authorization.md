# Workflow capability route authorization

Why `@corbits/agent-directory`'s `workflow-capability-routes.ts` skips a
grant-store check.

## The gap

The vendored grant-materialization path never seeds a `kind: "workflow"`
run's own principal a `workflow-definition: <its own id>/update` grant, so
`requireGrant` would 403 every self-update call a run makes for its own
definition until that vendor gap closes.

## The interim rule

Rather than block `request_capability` on an unpublished vendor change,
this route skips the grant-store check entirely for the one case it
accepts: a call whose authenticated run targets its own definitionId. That
narrow case is already gated by a stronger control than a grant row —
`@corbits/capability-tools`'s `request_capability` tool declares `approval:
"ask"`, so the reactor suspends every call as a pending approval and
renders it in-chat before this route ever runs. A human already had to
approve the specific addition; the human is the authorizer here, not a
grant row.

This route still enforces, unconditionally:

1. The caller's run must resolve to a live tenant/principal/run via the
   sidecar-token + run-address check.
2. The path `definitionId` must equal the resolved run's own definitionId
   (rejected 403 otherwise).
3. The addition must fail closed against the tenant's live capability
   inventory.

Once the real self-update grant is seeded in vendor grant materialization,
this route can route through `requireGrant` like every other
definition-mutating surface instead of carrying this interim rule.
