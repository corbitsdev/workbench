# @corbits/evals

Myra evals (CL-6143): `defineEval`/`runEval`, composable scorers, and a
persisted `evals.run` store that plays a hardcoded scripted scenario
against a real Myra deployment and grades what she actually did — never
what a prompt merely claims.

## CL-6322 §8.2 factory eval: `github-pr-review-factory`

`src/cases/github-pr-review-factory.ts` encodes the plan's §8.2 case —
"connect this GitHub organization and put every PR through an automated
review with greybeard, cto, and critique, plus suggested fixes" — in the
same `defineEval` idiom as the other two cases. It is written to be RED
today: three of its scorers read `ScorerContext.world` (the canonical
`WorldSnapshot` CL-6336 added) for real, but the remaining four still
need a harness or product capability that doesn't exist yet, and read a
`skipped` (or a plain, honest `fail`) result until those land. That's by
design — the case is the work list, not a bug report against itself.

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

### Scorer → blocking ticket

| #   | Scorer                                     | What it needs                                                             | Blocked on    | Why it's red today                                                                                                                                                                                                                             |
| --- | ------------------------------------------- | -------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `githubConnectedViaConnectionsLayer`       | `ScorerContext.world.connections`                                          | —             | Reads `ctx.world` for real (CL-6336 shipped it, always populated). Red on a live target only until the tenant actually has a live `github` connection.                                                                                       |
| 2   | `agentDefinitionsHaveToolGrants`           | `ctx.world.agentDefinitions`                                               | —             | Reads `ctx.world` for real. Red until the three reviewer handles are materialized definitions carrying a github-shaped tool pin.                                                                                                              |
| 3   | `triggerIsWebhookPerPr`                    | `ctx.world.routines`                                                       | —             | Reads `ctx.world` for real. Red until a routine's `trigger` resolves to `{kind: "webhook", webhookTriggerId}`.                                                                                                                                |
| 4   | `reviewCommentsAttributable`               | Per-comment `childRunId`                                                   | **Phase 1.3** | `WorldSnapshot` carries no `reviewComments` section at all — `onTrigger` adoption is what would give each fired occurrence its own child run id to attribute a comment to, and per the CL-6322 issue body nothing here uses `onTrigger` yet. |
| 5   | `suggestedFixesStructurallyValid`          | Nothing but the transcript — reads `ToolCall.result`/`arguments` directly | **CL-6325**   | Buildable today in isolation, but there is no successful `github_post_review_comment` call to ever check: `@corbits/github-tools` exposes only the read-only `github_activity`. Fails plainly (not skipped) with "no call yet."               |
| 6   | `outwardGitHubActionsRespectGrantBoundary` | Nothing but the transcript                                                | **CL-6325**   | Same root cause as #5 for its "free posting" half; its "merge parks" half is vacuously satisfied because Pass 1 of this case never calls a merge tool at all (outcome-ingest, including any merge action, is case two).                       |
| 7   | `wholeRunInspectable`                      | Per-run `eventLogRef`                                                      | **Phase 1.3** | `WorldSnapshot` carries no `runs` section at all — same `onTrigger`-adoption dependency as #4.                                                                                                                                                 |

**CL-6325** — give `@corbits/github-tools` (or a sibling package) a
GitHub write capability: `github_post_review_comment` at minimum, with
the free-under-grant / attributed contract above, and (separately) a
merge-class tool that always declares `approval: "ask"`.

**Phase 1.3** — per-turn/per-reviewer run-id tracing via `onTrigger`
adoption (CL-6322's own Phase 1). This is the single largest remaining
blocker and sits outside `packages/evals`' own scope entirely: closing
it means extending `WorldSnapshot` itself with `reviewComments`/`runs`
sections, which scorers 4 and 7 cannot go green without.

Run `bun test packages/evals` to see every scorer's current
`skipped`/`fail` reason first-hand — each one names its own blocking
ticket in `reason`, not just in this table.
