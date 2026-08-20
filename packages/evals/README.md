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

### Scoreboard (CL-6404 pass: `bun run eval` boots a complete world)

The case and every §8.2 scorer now grade the flow that actually merged
— template instantiation from the seeded library (CL-6344/#140),
per-repo grants + `webhook_trigger` rows minted at repo selection
(CL-6345/#142), one aggregated comment-only review posted free under
the grant by `github_post_pr_review` (CL-6340/#62; the tool's real
name — the previously documented `github_post_pull_request_review` was
itself stale), merge-class parked. `WorldSnapshot` also grew
`webhookTriggers` and now reads connector credentials (the GitHub PAT
the connections layer stores as the "GitHub" credential) as
connections, not just MCP servers, and the recorded GitHub MCP fake is
wired into `scripts/evals-run.ts`'s `bootMyraTarget`.

| #   | Scorer                                     | Result on a scratch-hub run | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `githubConnectedViaConnectionsLayer`       | **PASS**                    | `bun run eval` now snapshots the real world (CL-6404): the recorded GitHub MCP fake, connected through the real `POST /mcp-servers` route, reads back live through `listMcpServerConnections`. The Plugins-PAT half of a GitHub connect still cannot be seeded (`/:connectorId/complete` proves the token against real GitHub — CL-6403's baseUrl-seam lane).                                                                                               |
| 2   | `agentDefinitionsHaveToolGrants`           | **FAIL** (product gap)      | Half green for real now: the eval boot seeds the library with the same `seedTemplateLibrary` path hub boot runs, and the `install-template` step drives #140's instantiation route-for-route, so all three reviewer definitions materialize in the snapshot. Still red because the shipped install path itself never deploys the template's `code-review` block workflow per tenant — no deployed definition carries the github pin, in production or here. |
| 3   | `triggerIsWebhookPerPr`                    | **FAIL** (harness gap)      | The `Target` can now fire a trigger (`fireWebhook`, CL-6404), but none exists to fire: start-reviewing's per-repo mint needs the Plugins PAT and repo listing against a fake-able GitHub REST boundary (CL-6403) plus #2's deployed `code-review` definition. The fire-webhook step records that miss honestly instead of crashing the run.                                                                                                                 |
| 4   | `reviewCommentsAttributable`               | **SKIP** (product gap)      | `WorldSnapshot` has no `reviewComments` field — blocked on CL-6322 Phase 1 (`onTrigger` adoption giving each fired occurrence its own child run id).                                                                                                                                                                                                                                                                                                        |
| 5   | `suggestedFixesStructurallyValid`          | **FAIL** (harness gap)      | Retargeted to the aggregated-review shape: non-empty `body` + `headSha`, well-formed inline comments, at least one ` ```suggestion ` fence. Red until a PR event can actually fire (#3) and the run can post against a fake-able GitHub REST boundary (#1's seam, which the sidecar's pinned `@corbits/github-tools` would also need to honor).                                                                                                             |
| 6   | `outwardGitHubActionsRespectGrantBoundary` | **FAIL** (harness gap)      | Retargeted: posts scoped by `pullRequestUrl` under the granted repo, attribution = reviewer lens names in the aggregated body, no approval phrase required; merge-class still parks (vacuous today — no merge tool exists, by design). Red for the same reason as #5.                                                                                                                                                                                       |
| 7   | `wholeRunInspectable`                      | **SKIP** (product gap)      | `WorldSnapshot` has no `runs` field. Blocked on CL-6322 Phase 1.                                                                                                                                                                                                                                                                                                                                                                                            |

### Remaining gaps, precisely

Everything below is what still stands between this case and green —
none of it is scorer drift any more:

0. **Closed (CL-6404).** `scripts/evals-run.ts` wires
   `captureWorldSnapshot` through `apps/hub`'s own `createBootAssetWiring`
   factory — the boot composition itself, pointed at the scratch hub's
   data dir — so `bun run eval`'s world scorers grade real tenant state
   (see #1 going green above).

1. **No fake-able GitHub REST boundary.** The connect card
   (`connect-github-routes.ts`), the `/complete` credential prove, and
   the sidecar's pinned `@corbits/github-tools` all hit
   `https://api.github.com` unconditionally. `GitHubClientConfig`
   already has a `baseUrl` test seam; `apps/hub`'s `resolveGithubConfig`
   and the tool package's credential delivery never populate it. Until
   a hub-config override (and a matching tool-package release) exists,
   scorers #3/#5/#6 cannot go green against a scratch deployment, and
   #1's Plugins-PAT half stays unseedable.
2. **Mostly closed (CL-6404).** Eval boot seeds the bench library via
   the same `seedTemplateLibrary` path hub boot runs (scratch admin in
   place of the operator bench), the case's `install-template` step
   drives the real instantiation surfaces, and `fireWebhook` rides the
   real HMAC-signed ingress route. What remains is not harness work:
   nothing in the shipped install deploys the `code-review` block
   workflow per tenant (the missing half of #2), and start-reviewing
   cannot mint a trigger until gap 1 falls.

3. **CL-6322 Phase 1 (`onTrigger` adoption)** — unblocks #4/#7
   (per-comment and per-run ids in the snapshot). Unchanged.

Run `bun test packages/evals` to see every scorer's current
`skipped`/`fail` reason first-hand — each one names its own blocker in
`reason`, not just in this table. Run `DATABASE_URL=... bun run eval`
for the full plumbing-mode harness proof (every step still produces a
turn); pass a real `EVAL_PROVIDER_API_KEY` for genuine scorer grading
against live model output.
