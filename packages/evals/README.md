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

### Scoreboard (CL-6340 pass: case + scorers cut over to the shipped product)

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

| #   | Scorer                                     | Result on a scratch-hub run | Why                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `githubConnectedViaConnectionsLayer`       | **FAIL** (harness gap)      | The scorer is honest now (snapshot reads connector credentials), but the harness cannot seed one: `POST /:connectorId/complete` proves the pasted PAT against real GitHub before storing it, and there is no fake-able GitHub REST seam — `resolveGithubConfig` in `apps/hub` returns `{apiKey}` only, never a `baseUrl`, even though `GitHubClientConfig.baseUrl` exists for tests. |
| 2   | `agentDefinitionsHaveToolGrants`           | **FAIL** (harness gap)      | Retargeted to the shipped install shape: reviewer roster materialized + the `code-review` definition carrying the github pin. Red because the harness can't drive the install: the library seed runs off the env-credential-plant admin (`ORG_SLUG` bench), which a scratch eval hub doesn't configure, and nothing deploys the `code-review` workflow per tenant in the eval boot.  |
| 3   | `triggerIsWebhookPerPr`                    | **FAIL** (harness gap)      | Retargeted to the real trigger: an enabled `webhook_trigger` row (start-reviewing's per-repo mint), read straight off the table. Red because start-reviewing needs the GitHub connection of #1 and the deployed definition of #2.                                                                                                                                                   |
| 4   | `reviewCommentsAttributable`               | **SKIP** (product gap)      | `WorldSnapshot` has no `reviewComments` field — blocked on CL-6322 Phase 1 (`onTrigger` adoption giving each fired occurrence its own child run id).                                                                                                                                                                                                                                |
| 5   | `suggestedFixesStructurallyValid`          | **FAIL** (harness gap)      | Retargeted to the aggregated-review shape: non-empty `body` + `headSha`, well-formed inline comments, at least one ` ```suggestion ` fence. Red until a PR event can actually fire (#3) and the run can post against a fake-able GitHub REST boundary (#1's seam, which the sidecar's pinned `@corbits/github-tools` would also need to honor).                                       |
| 6   | `outwardGitHubActionsRespectGrantBoundary` | **FAIL** (harness gap)      | Retargeted: posts scoped by `pullRequestUrl` under the granted repo, attribution = reviewer lens names in the aggregated body, no approval phrase required; merge-class still parks (vacuous today — no merge tool exists, by design). Red for the same reason as #5.                                                                                                                |
| 7   | `wholeRunInspectable`                      | **SKIP** (product gap)      | `WorldSnapshot` has no `runs` field. Blocked on CL-6322 Phase 1.                                                                                                                                                                                                                                                                                                                   |

### Remaining gaps, precisely

Everything below is what still stands between this case and green —
none of it is scorer drift any more:

0. **`bun run eval` still grades world scorers against an empty
   snapshot.** `scripts/evals-run.ts` never passes
   `infra.captureWorldSnapshot` to `bootMyraTarget` — wiring it needs
   the hub's own `AssetService` (built on the boot-time agent-repo
   store and signing key inside the hub process), which the external
   e2e harness has no handle on. Until the hub exposes a read path (or
   the harness rebuilds an AssetService over the same data dir), even
   state the run really created — e.g. the connected GitHub MCP fake —
   reads as absent to scorers #1–#3 in `bun run eval`; a caller that
   wires `captureWorldSnapshot` gets honest grading today.

1. **No fake-able GitHub REST boundary.** The connect card
   (`connect-github-routes.ts`), the `/complete` credential prove, and
   the sidecar's pinned `@corbits/github-tools` all hit
   `https://api.github.com` unconditionally. `GitHubClientConfig`
   already has a `baseUrl` test seam; `apps/hub`'s `resolveGithubConfig`
   and the tool package's credential delivery never populate it. Until
   a hub-config override (and a matching tool-package release) exists,
   scorers #1/#3/#5/#6 cannot go green against a scratch deployment.
2. **Eval boot doesn't install the code-review template.** The bench
   library seed runs via the env-credential-plant admin at hub boot
   (`template-library-seed.ts`), and `code-review` is not in
   `DEFAULT_WORKFLOWS`, so an eval tenant has neither the seeded
   manifest nor a deployed `code-review` definition. The harness needs
   to drive the real install surfaces (library read → participant
   creation → start-reviewing) once gap 1 falls; the `Target` also
   still needs a `fireWebhook(triggerId, payload)` capability beside
   `fireRoutine` for step 4.
3. **CL-6322 Phase 1 (`onTrigger` adoption)** — unblocks #4/#7
   (per-comment and per-run ids in the snapshot). Unchanged.

Run `bun test packages/evals` to see every scorer's current
`skipped`/`fail` reason first-hand — each one names its own blocker in
`reason`, not just in this table. Run `DATABASE_URL=... bun run eval`
for the full plumbing-mode harness proof (every step still produces a
turn); pass a real `EVAL_PROVIDER_API_KEY` for genuine scorer grading
against live model output.
