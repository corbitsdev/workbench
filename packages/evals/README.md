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

### Scoreboard (as of this run, against main + the merge-train case)

CL-6336 (world-snapshot scorers) and CL-6340/#62 (Code Review MVP)
have both landed since this table was first written. Re-checked here
against what actually shipped, not what was assumed at write time.

| #   | Scorer                                     | Result                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `githubConnectedViaConnectionsLayer`       | **FAIL**                             | `ctx.world` is populated now (CL-6336 done), but nothing in this case's step 2 calls a real connect route — it only narrates a PAT connect in the human message (a documented harness gap: real connect finishes in the browser, see the case's own step-2 comment). `world.connections` is empty, so this correctly fails, not skips.                                                                                                                                                                                                                                                                                                                                                |
| 2   | `agentDefinitionsHaveToolGrants`           | **FAIL**, citation stale             | Same cause: no `create_agent` call for greybeard/cto/critique ever ran, because the shipped Code Review MVP doesn't create three per-tenant agent definitions at all — it installs `workflows/code-review`, a single mail-triggered workflow pinning `@corbits/github-tools`. The reviewer "personas" are prompts inside `@corbits/code-review`'s roster, not agent-directory rows. This scorer's whole premise (three materialized definitions with github-shaped tool pins) doesn't match the shipped install shape.                                                                                                                                                                |
| 3   | `triggerIsWebhookPerPr`                    | **FAIL**                             | No `routine_create` call ran either, for the same reason as #2 — trigger wiring is the installed workflow's own webhook-triggers registration (CL-6344's install path), not a chat-driven `routine_create`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | `reviewCommentsAttributable`               | **SKIP**                             | `WorldSnapshot` (types.ts) has no `reviewComments` field — nothing populates per-comment/per-run attribution. Real gap, not a stale citation: still blocked on CL-6322 Phase 1 (`onTrigger` adoption giving each fired occurrence its own child run id).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | `suggestedFixesStructurallyValid`          | **FAIL**, citation was stale (fixed) | The write tool this scorer looks for, `github_post_review_comment`, never runs — but not because no write tool exists. CL-6340/#62 shipped `github_post_pull_request_review` in `@corbits/github-tools`: one aggregated review per PR (three lenses merged, findings deduped), posted by the workflow run itself, not N per-reviewer `suggestedFix`-bearing comments from three agents. Old citation (`CL-6325`, "no GitHub write tool exists") was wrong on two counts: the tool exists, and CL-6325 itself has since been repurposed to an unrelated ticket (sidecar `invokeAction`/`loopFns` binding) — citing it here would point at the wrong work entirely. Fixed in this pass. |
| 6   | `outwardGitHubActionsRespectGrantBoundary` | **FAIL**, citation was stale (fixed) | Same root cause as #5 for the "free posting" half. The "merge parks" half stays vacuously satisfied — no merge-class tool exists at all in the shipped MVP (posting is comment-only, by design; the owner ruling this scorer checks for merge-gating literally cannot be violated because there is nothing to violate it with yet).                                                                                                                                                                                                                                                                                                                                                   |
| 7   | `wholeRunInspectable`                      | **SKIP**                             | Same as #4 — `WorldSnapshot` has no `runs` field. Blocked on CL-6322 Phase 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Also found while re-verifying: the recorded GitHub MCP fake
(`src/fakes/recordings/github.json`, from CL-6338) is never passed to
`bootMyraTarget` by `scripts/evals-run.ts` — `mcpFakes` defaults to
`[]` there. Wiring it in only changes behavior once a live run (a real
`EVAL_PROVIDER_API_KEY`) actually drives Myra to call connect/GitHub
tools; plumbing-only mode never calls a tool at all (the stub
credential short-circuits every turn to a canned credential-error
reply), so this wasn't verifiable in this pass without a live key.

### Priority-ordered work list

Smallest change that flips each non-passing scorer, ranked by leverage:

1. **Rewrite the case's steps 2–3 against the real install shape
   (CL-6344, template install path).** The case currently scripts
   "connect GitHub in chat → `create_agent` × 3 → `routine_create`."
   The shipped product installs `workflows/code-review` as one
   manifest-driven unit. Scorers #2 and #3 are grading a UX that no
   longer exists; rewriting them to check "the code-review template is
   installed, bound to the tenant's `github` credential, webhook-live"
   is the highest-leverage single change — it turns two structural
   failures into a real pass/fail on the actual product.
2. **Decide and then re-target #5/#6 on `github_post_pull_request_review`.**
   Either accept "one aggregated review, no per-reviewer attribution"
   as the real contract (rewrite the scorers to check that shape:
   `suggestedFix`-bearing findings inside the one review body, `repo`
   scoping, no approval-phrase gate) or open a ticket for per-reviewer
   attributed posting if that's still wanted — right now the case
   silently expects the latter with no ticket backing it.
3. **CL-6322 Phase 1 (`onTrigger` adoption)** unblocks #4 and #7
   together — it's what would let a snapshot read back per-comment and
   per-run ids at all. No smaller fix exists for these two; they are
   correctly blocked on the same large piece of work Phase 1 already
   names.
4. **Wire `src/fakes/recordings/github.json` into `scripts/evals-run.ts`'s
   `bootMyraTarget` call**, gated by eval name, so a live run actually
   exercises the fake instead of only unit tests doing so. Low effort,
   but only observable with a live key — could not be verified in this
   pass.

Run `bun test packages/evals` to see every scorer's current
`skipped`/`fail` reason first-hand — each one names its own blocker in
`reason`, not just in this table. Run `DATABASE_URL=... bun run eval`
for the full plumbing-mode harness proof (every step still produces a
turn); pass a real `EVAL_PROVIDER_API_KEY` for genuine scorer grading
against live model output.
