# `workflow_deploy_source` vs `workflow_run_launch_spec`

Analysis for CL-7271. Read against the vendored pin `a8bc06ae`.

## The claim under test

CL-7271 was filed on the claim that `@corbits/workflow-deploy-source` duplicates
Interchange's native `workflow_run_launch_spec`, and should be deleted in favour
of it.

**That claim is too strong.** The two tables share a key, a purpose statement and
several columns, but they implement _different recovery models_. Deleting one for
the other is a design decision, not a cleanup.

## What each one actually stores

|                   | `workflow_run_launch_spec` (native)                                               | `workflow_deploy_source` (ours)                                   |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Key               | `anchor_run_id` (FK → `workflow_run`, cascade)                                    | `anchor_run_id` (no FK)                                           |
| Written by        | `prepareExclusiveDeployment` only                                                 | `withDeploySourceRecording`, every placement                      |
| Written when      | Inside the same transaction as the anchor `workflow_run` row and its `read` grant | After a deploy resolves                                           |
| Recovery payload  | `frozen_approval_bundle` — the whole approval, verbatim                           | `source` + `entry` + `pin` + `definition_asset_id` + `source_ref` |
| Redeploy strategy | **Replay the freeze.** No re-probe                                                | **Re-resolve from the source.** Re-derives                        |
| Shared columns    | `session_id`, `deployment_domain`, `source_authority_principal_id`                | `tenant_id`, `deployment_domain`, `source_authority_principal_id` |
| Secrets           | None — offering ids re-resolved at launch                                         | None — inference sources re-resolved at redeploy                  |

## Why native is exclusive-only

`createWorkflowRunLaunchSpecStore` has exactly one writer and one reader, both in
`vendor/intx/hub-sessions/src/workflow-allocation-service.ts`:

- `prepareExclusiveDeployment` (line 250) writes the spec inside the transaction
  that mints the anchor run and its grant.
- `deployReadyAllocation` (line 327) reads it back and rehydrates
  `InstallAndApproveResult` from `spec.frozenApprovalBundle` — approved wire hash,
  approved grants, projection — then deploys with **no re-probe**.

It is exclusive-only because it is part of the _exclusive allocation lifecycle_:
it exists to survive an allocation being replaced under a run. A shared-capacity
deploy has no allocation generation to lose, so upstream never needed it there.

## The real difference: freeze vs re-resolve

This is the crux, and it is a genuine design fork.

**Native freezes.** `frozen_approval_bundle` is the approval verbatim. A redeploy
replays exactly what was approved — same wire hash, same grants, same projection.
Nothing is recomputed, so nothing can drift. The cost: an approval frozen against
a credential that later died stays frozen, and the run redeploys against a dead
chain forever.

**Ours re-resolves.** We store where the bytes came from and re-derive at redeploy
against the tenant's live catalog. A rotated credential is picked up. The cost: the
redeploy is not guaranteed to reproduce what was approved.

That trade-off is exactly the one CL-6687 ("Rotated API keys never reach live
agents", Done) was fixed in favour of re-resolution, and the same one
`apps/sidecar/src/workflow-host-wiring/index.ts`'s `restoreDeploymentFromRecord`
decides the same way when it returns `"deferred-to-wake"` rather than restoring
from a frozen `sources` snapshot (CL-6648).

So the two tables encode opposite answers to the same question, and this repo has
already ruled twice in favour of re-resolution.

## What this means for the ticket

Adopting `workflow_run_launch_spec` wholesale would mean adopting the freeze model
for every placement, and re-opening CL-6687. That is not a cleanup.

The defensible options, in order of preference:

1. **Keep both, narrow ours.** Native owns exclusive-allocation recovery (it
   already does). Ours owns shared-placement source recording. Document the split
   and stop describing them as duplicates. Cheapest, and preserves both rulings.
2. **Extend native with a re-resolve arm.** Add the source/entry/pin columns to
   `workflow_run_launch_spec` as an alternative to `frozen_approval_bundle`, and
   raise it upstream. One table, two recovery strategies, chosen per row. Larger,
   and needs upstream agreement.
3. **Cut over to freeze.** Rejected — reverses CL-6687.

Option 1 does not delete any code. That is the honest outcome: the ~350 loc in
`@corbits/workflow-deploy-source` is not redundant, and CL-7271's premise that it
could simply be deleted does not survive reading the native writer.

## What still stands from CL-7271

Two of the original observations survive independently of the above:

- `workflow_deploy_source.anchor_run_id` has **no foreign key** into
  `workflow_run`, where the native table has one with `onDelete: "cascade"`.
  That is a real defect and belongs to CL-7258.
- The columns that genuinely have no native counterpart are `entry`, `pin`,
  `definition_asset_id` and `source_ref` — the last already carries an in-tree
  `WORKBENCH DELTA` comment. These are what option 2 would need to upstream.

## Not verified

- Whether any shared-placement deploy could ever lose its allocation the way an
  exclusive one can. If it cannot, ours is recording for a recovery that never
  happens, which is a separate question worth asking.
- Migration shape for existing `workflow_deploy_source` rows under option 2.
