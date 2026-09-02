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
`@corbits/workflows`'s `./source`'s `RetiredWorkflowEnvelopeError` is the only
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
| Store source (create / republish) | `@corbits/workflows`'s `./authoring` registry → `AssetService.createAsset` / `populateAsset` (hub-signed commit)                                      | Initiating tenant + principal; `@intx/authz` `authorize` on `asset:*`/`create` or `asset:<id>`/`write` | None (writing source is not a side effect)                                                                       |
| Deploy source                     | `POST /api/tenants/:tenantId/workflows/deployments` → vendored `SessionService.deployWorkflowFromSource`                                              | Tenant session or run bearer; `workflow:*`/`create`                                                    | Agent-initiated deploys go through an `approval: "ask"` tool call carrying the probed capability surface (below) |
| Create / update a routine         | `createRoutineRoutes` `POST /routines`, `PATCH /routines/:id`; the run-authenticated mirror `createWorkflowRoutineRoutes` delegates to the same store | Tenant + principal; target validated against the resolution rule above before persisting               | None; a routine only references a definition asset — nothing executes at create/update time                      |
| Launch                            | `launchAndCorrelate` (`packages/routines/src/routes.ts`) → hub `RoutineLauncher`                                                                      | Routine's tenant; grants materialized by the native launch path                                        | Runtime tool calls with `approval: "ask"` park on the native `approval` resource                                 |
| Approve                           | Native `POST /api/tenants/:tenantId/approvals/:id/approve`                                                                                            | A principal holding `approval:*`/`resolve` — a human; no agent holds it                                | This is the approval                                                                                             |

Credentials and resolved provider secrets never enter source trees, deploy
requests recorded by `@corbits/workflows`'s `./deploy-source`, or routine rows.
Inference sources are re-resolved from the tenant catalog at deploy and
redeploy (`resolveDefinitionSources`).

### Deploy approval for agent-authored workflows

Upstream's deploy route freezes with `approvals: { mode: "approve-probed" }`
(`vendor/intx/hub-sessions/src/session-service.ts`), unmodified — no
vendored delta grants a caller-supplied approval policy or a
probe-without-freeze entry point (one was prototyped for CL-7362 and
reverted; see VENDORED.md). The only native pending-approval store is the
runtime `approval` resource that an `approval: "ask"` tool call parks on.
Workbench composes what exists, with no vendored delta and no approval
table:

1. Myra calls `wf_deploy_preview`, a STATIC, read-only render of the
   already-committed source at `commitSha` — package name, file list, and
   any `toolPackagePins` a plain `export default {...}` entry declares.
   Never installs, probes, gates, or freezes anything, so it truly cannot
   deploy.
2. Myra calls `workflow_deploy` (`approval: "ask"`) with the asset id,
   commit sha, entry, and the preview's `packageName`/`toolPackagePins`
   carried along on the call. The tool call parks; the approval headline
   reads "Deploy workflow \<packageName\> @ \<sha7\> — tools: \<pins or "none
   declared"\>" — the committed source the human is approving, not yet the
   grants/capabilities the deploy will freeze (no no-freeze probe seam
   exists to preview those; see the vendored-delta revert above).
3. On approval the tool posts to the native deployments route, which runs
   the real install + probe + gate + freeze under the default
   `approve-probed` policy. A rejection there leaves the source intact and
   the definition unlaunchable; runtime tool calls against the deployed
   definition remain approval-gated regardless.

Myra cannot resolve approvals: `approval:*`/`resolve` is never minted for an
agent principal.

## Deleted in CL-7364

- Routine target inference from chat membership: `apps/web/src/shell/
routine-panel.tsx` picks a target only through `DefinitionTargetPicker`
  now; no `resolveCreateTarget`, `agents[0]?.definitionId`, or "no agent
  invited" guard remains. `check:routine-target-inference` guards this —
  it fails on `agents[0]?.definitionId` / `agents[0].definitionId` in
  `apps/web` and `packages/chat-ui`.
- The template-block route's hub-local self-freeze: `apps/hub/src/index.ts`
  (`createTemplateBlockRoutes`'s `deployWorkflowSource` binding) writes the
  block's source tree and calls the same `workflowDeployer.deploy` the
  agent-authored deploy path uses, instead of
  `@corbits/workflow-freeze`'s `freezeInertWorkflowDefinition`.
- `packages/workflow-host-actions` — already gone (no tracked source, no
  importers) by the time this landed.
- Any code path that reads or writes the retired `workflow.json` path,
  except `@corbits/workflows`'s `./source`'s own `RetiredWorkflowEnvelopeError`;
  `check:routine-target-inference` guards this too.

`@corbits/workflow-freeze` itself is deleted: `packages/agent-directory`
(create, restore, skill-pin, and capability routes in `apps/hub/src/
index.ts`) now deploys agent definitions through the same injected
`WorkflowDeployer` the template-block path uses, instead of
`DefinitionFreezer.freeze`/`.refreeze` (CL-7364). `packages/routines-tools/
src/client.ts` never carried duplicate wire shapes to delete; it already
re-exports `@corbits/routines/client`.

No compatibility shim, feature flag, or dual-write period accompanies any
of the deletions above.

## What is not native, and stays in Workbench

Checked against upstream origin/main `d187e327`: Interchange has no
routine or scheduler (its `ScheduleTrigger` type has zero consumers), no
per-principal "launchable definitions" query, and no agent-facing tool that
writes assets. Those three compositions are Workbench's, built over native
rows and `@intx/authz`. Before adding anything else, check upstream first;
if upstream has it past our pin, re-vendor at that commit rather than
reimplementing.
