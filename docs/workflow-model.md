# Workflows, agents, routines, and runs — the canonical model

Contract for CL-7349. Read against the vendored pin `a8bc06ae` and upstream
`faremeter/interchange` origin/main `d187e327` (2026-09-01). Every
implementer of the Routines & Workflow Alignment project builds to this
document; a surface that disagrees with it is wrong until this document
changes.

## Five nouns, one execution model

| Noun                    | What it is                                                                                                                                                                  | Where it lives                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow source**     | A versioned code package: `package.json` declaring `interchange.workflow` plus the entry module it names, default-exporting a `WorkflowDefinition`                          | A tenant-scoped `kind: "workflow"` asset in the hub's git-backed asset store (`AssetService`)                                         |
| **Deployed definition** | The frozen, approved projection of one source commit: `workflow_definition` row with non-null `approved_wire_hash`, `grant_snapshot`, `wire_projection`, `status: deployed` | Produced only by Interchange's source pipeline (`deployWorkflowFromSource`: bundle → sidecar probe → capability walk → gate → freeze) |
| **Agent**               | A single-step conversational workflow. A product category, not an execution primitive                                                                                       | Same asset + same deployed definition as any workflow                                                                                 |
| **Routine**             | Trigger, launch input, delivery configuration, enabled state, and an explicit reference to a definition                                                                     | `@corbits/routines` (`routine` table)                                                                                                 |
| **Run**                 | One execution of an approved deployed definition                                                                                                                            | `workflow_run`, launched by `launchAndCorrelate`                                                                                      |

`workflow.json` is retired. It is not an authoring format, not a
compatibility format, and no path may read or write it. The push validator
(`vendor/intx/hub-sessions/src/workflow-kind.ts`) refuses it;
`@corbits/workflow-source`'s `RetiredWorkflowEnvelopeError` is the only
remaining mention, and it exists to reject.

## Definition identity and the follow-latest rule

Interchange keys `workflow_definition` on `(asset_id, wire_hash)`
(`vendor/intx/hub-sessions/src/workflow-definition-ensure.ts`). Every
redeploy of a source asset whose probed wire hash differs mints a **new**
definition row. There is no native "definition id → newest approved
deployment" indirection; every native launch names an exact definition.

Product ruling (2026-09-01): a routine follows its target's latest approved
deployment and does not pin the version selected at creation. Under the
identity above that means:

- A routine stores the **definition asset id** (`routine.definition_asset_id`,
  `NOT NULL`). The asset is the stable identity of a workflow across
  redeploys.
- At launch, the routine's target resolves to the newest `workflow_definition`
  row for that asset with `status = 'deployed'` and non-null
  `approved_wire_hash`, `grant_snapshot`, and `wire_projection`. Resolution
  is atomic with the launch and fails closed when no such row exists.
- Routine reads return both the asset id (identity) and the currently
  resolved definition id (what would run now) so UI and Myra can show them.

Nothing in Workbench pins a wire hash or copies a projection into routine
storage.

## Authority boundaries

| Operation                         | Canonical operation                                                                                                                                   | Authorized as                                                                                          | Human approval                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Store source (create / republish) | `@corbits/agent-workflow-authoring` registry → `AssetService.createAsset` / `populateAsset` (hub-signed commit)                                       | Initiating tenant + principal; `@intx/authz` `authorize` on `asset:*`/`create` or `asset:<id>`/`write` | None (writing source is not a side effect)                                                                       |
| Deploy source                     | `POST /api/tenants/:tenantId/workflows/deployments` → vendored `SessionService.deployWorkflowFromSource`                                              | Tenant session or run bearer; `workflow:*`/`create`                                                    | Agent-initiated deploys go through an `approval: "ask"` tool call carrying the probed capability surface (below) |
| Create / update a routine         | `createRoutineRoutes` `POST /routines`, `PATCH /routines/:id`; the run-authenticated mirror `createWorkflowRoutineRoutes` delegates to the same store | Tenant + principal; target validated against the resolution rule above before persisting               | None; a routine only references                                                                                  |
| Launch                            | `launchAndCorrelate` (`packages/routines/src/routes.ts`) → hub `RoutineLauncher`                                                                      | Routine's tenant; grants materialized by the native launch path                                        | Runtime tool calls with `approval: "ask"` park on the native `approval` resource                                 |
| Approve                           | Native `POST /api/tenants/:tenantId/approvals/:id/approve`                                                                                            | A principal holding `approval:*`/`resolve` — a human; no agent holds it                                | This is the approval                                                                                             |

Credentials and resolved provider secrets never enter source trees, deploy
requests recorded by `@corbits/workflow-deploy-source`, or routine rows.
Inference sources are re-resolved from the tenant catalog at deploy and
redeploy (`resolveDefinitionSources`).

### Deploy approval for agent-authored workflows

Upstream's deploy route freezes with `approvals: { mode: "approve-probed" }`
(`vendor/intx/hub-sessions/src/session-service.ts`); the `ApprovalSet`
gate exists as a policy type but has no pending-approval record. The only
native pending-approval store is the runtime `approval` resource that an
`approval: "ask"` tool call parks on. Workbench composes those two seams and
adds no approval table:

1. Myra calls a preview operation that runs the native probe with an empty
   `ApprovalSet` and returns the walked grant surface plus the wire hash. No
   freeze.
2. Myra calls `workflow_deploy` (`approval: "ask"`) with the asset id,
   commit sha, expected wire hash, and that grant list. The tool call parks;
   the human sees exactly what will be approved.
3. On approval the tool posts to the native deployments route. The native
   probe re-runs; a wire hash that differs from the approved one fails
   closed. Rejection leaves the source intact and the definition
   unlaunchable.

Myra cannot resolve approvals: `approval:*`/`resolve` is never minted for an
agent principal.

## Behavior to delete, not retain

- Routine target inference from chat membership: `resolveCreateTarget` in
  `apps/web/src/shell/routine-panel.tsx` (`agents[0]?.definitionId`,
  `ensureMyraWorkbench` fallback) and the "no agent invited" guards around
  it.
- Hub-local self-freeze of agent-authored definitions:
  `packages/agent-directory`'s use of `@corbits/workflow-freeze`
  `DefinitionFreezer`, and the template-block inert freeze in
  `apps/hub/src/index.ts`, once those callers deploy natively.
- Duplicate routine wire shapes in `packages/routines-tools/src/client.ts`
  (use `@corbits/routines/client`).
- `packages/workflow-host-actions` (no tracked source, no importers).
- Any code path that reads or writes `workflow.json`.

No compatibility shim, feature flag, or dual-write period accompanies any of
these deletions.

## What is not native, and stays in Workbench

Checked against upstream origin/main `d187e327`: Interchange has no
routine or scheduler (its `ScheduleTrigger` type has zero consumers), no
per-principal "launchable definitions" query, and no agent-facing tool that
writes assets. Those three compositions are Workbench's, built over native
rows and `@intx/authz`. Before adding anything else, check upstream first;
if upstream has it past our pin, re-vendor at that commit rather than
reimplementing.
