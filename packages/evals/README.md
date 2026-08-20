# @corbits/evals

Myra evals (CL-6143): `defineEval`/`runEval`, composable scorers, and a
persisted `evals.run` store that plays a hardcoded scripted scenario
against a real Myra deployment and grades what she actually did — never
what a prompt merely claims.

## CL-6322 §8.2 factory eval: `github-pr-review-factory`

`src/cases/github-pr-review-factory.ts` encodes the plan's §8.2 case —
"connect this GitHub organization and put every PR through an automated
review with greybeard, cto, and critique, plus suggested fixes" — in the
same `defineEval` idiom as the other two cases. It was written to be RED
by design — the case is the work list, not a bug report against itself
— and `bun run eval` (plumbing-only, no `EVAL_PROVIDER_API_KEY`) proves
end to end against a real hub + sidecar that every step still produces
a turn even with every scorer red.

Two rulings from the owner are baked into the case's step 4:

- Posting a review comment is **free** under a valid per-repo GitHub
  grant — it must never wait on a human approval phrase, but every post
  must still be audit-attributable to the posting agent.
- A merge-class action (landing a merge, not reviewing) **does park**
  behind an explicit human approval, the same way `routine_create`
  already does.

`outwardGitHubActionsRespectGrantBoundary` grades both halves of that
ruling in one scorer, so a case that accidentally gates reviews or
accidentally frees merges fails loudly either way.

### Scoreboard (CL-6405 pass: install deploys the block workflow, GitHub REST rides the seam)

The install path now deploys the template's referenced `code-review`
block workflow per tenant (`instantiateWorkbenchTemplate`'s
`deployBlockWorkflow` port -> `POST /template-blocks/:assetName/deploy`),
the eval boot stands up a fake GitHub REST origin and threads it through
the hub's `GITHUB_API_BASE_URL` (CL-6403's seam), connects the PAT
through the real `/connections/github/complete` route, and drives the
connect card's start-reviewing step after install — so the per-repo
grant and `webhook_trigger` row mint for real and the fire-webhook step
fires an actual trigger.

| #   | Scorer                                     | Result on a scratch-hub run | Why                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `githubConnectedViaConnectionsLayer`       | **PASS**                    | Both halves now: the MCP fake connects through the real `POST /mcp-servers` route, and the Plugins PAT proves against the fake REST origin through the real `/:connectorId/complete` (CL-6403's `probeBaseUrls`).                                                                                                                  |
| 2   | `agentDefinitionsHaveToolGrants`           | **PASS**                    | The three reviewer definitions materialize via the real install, and the install now also deploys the `code-review` block workflow carrying the `@corbits/github-tools` pin (CL-6405's product fix). The snapshot's `name` is the stable definition handle (`displayName` carries the label), so handle matching is exact.        |
| 3   | `triggerIsWebhookPerPr`                    | **PASS**                    | Install drives start-reviewing against the fake REST origin's repo list; one enabled `webhook_trigger` row mints per repo, bound to the deployed `code-review` definition.                                                                                                                                                        |
| 4   | `reviewCommentsAttributable`               | **SKIP** (product gap)      | `WorldSnapshot` has no `reviewComments` field — blocked on CL-6322 Phase 1 (`onTrigger` adoption giving each fired occurrence its own child run id).                                                                                                                                                                              |
| 5   | `suggestedFixesStructurallyValid`          | **FAIL** (two gaps below)   | The delivery now reaches a real enabled trigger, but the launch 500s: `DefinitionProjectionMissingError` — see gap 1. Even once launched, a posted review needs genuine model tool calls, i.e. a live `EVAL_PROVIDER_API_KEY` run — plumbing mode's stub credential can never call `github_post_pr_review`.                        |
| 6   | `outwardGitHubActionsRespectGrantBoundary` | **FAIL** (two gaps below)   | Same two blockers as #5.                                                                                                                                                                                                                                                                                                          |
| 7   | `wholeRunInspectable`                      | **SKIP** (product gap)      | `WorldSnapshot` has no `runs` field. Blocked on CL-6322 Phase 1.                                                                                                                                                                                                                                                                  |

### Remaining gaps, precisely

1. **The block-workflow deploy records no frozen wire projection.** A
   webhook-fired launch (`launchWebhookTrigger` ->
   `readDefinitionProjection`) reads the definition's frozen inert
   projection off its version row — recorded only by the sidecar
   probe/approve gate (`installAndApproveWorkflowDefinition`, the path
   behind `POST /workflows/deployments`). The template-block deploy
   (like the agent-directory create it mirrors) materializes the asset
   and `workflow_definition` row but never probes, so firing the
   trigger answers `DefinitionProjectionMissingError` ("No stored
   launch body for definition \"code-review\""). True in production,
   not just here: the block deploy needs to ride the platform's real
   probe-and-freeze deployment path (or the webhook launch needs the
   same lazy-freeze a first wake performs). Next ticket, never a hack.
2. **Scorers #5/#6 need a live run.** They grade genuine
   `github_post_pr_review` tool calls off the trace; a plumbing-mode
   stub credential produces a credential-error turn with no tool calls
   by design. Re-run with `EVAL_PROVIDER_API_KEY` once gap 1 falls.
3. **CL-6322 Phase 1 (`onTrigger` adoption)** — unblocks #4/#7
   (per-comment and per-run ids in the snapshot). Unchanged.

Also closed in this pass: `workflows/code-review` pinned
`@corbits/github-tools@0.0.3` while CL-6403 released 0.0.4 (the
baseUrl seam), so closure resolution would have failed at wake; the pin
now names 0.0.4.

Run `bun test packages/evals` to see every scorer's current
`skipped`/`fail` reason first-hand — each one names its own blocker in
`reason`, not just in this table. Run `DATABASE_URL=... bun run eval`
for the full plumbing-mode harness proof (it now also prints every
failing scorer's reason and each harness step's outcome line); pass a
real `EVAL_PROVIDER_API_KEY` for genuine scorer grading against live
model output.
