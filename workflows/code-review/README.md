# Code review

A pull request comes in, three reviewer lenses read its diff, and one
review is posted back on the pull request.

## The loop

1. **A pull request event arrives.** A GitHub `pull_request` webhook
   registered through `@corbits/webhook-triggers` verifies the delivery,
   renders its input template, and launches one run per event. The
   template this definition expects is
   `CODE_REVIEW_WEBHOOK_INPUT_TEMPLATE`:

   ```
   Review this pull request: {{pull_request.html_url}}
   ```

   The same run can be started by hand — the trigger is mail to the
   deployment's address, so a message naming a pull-request URL is a
   review request.

2. **The diff is read once.** `github_pull_request_diff` (from
   `@corbits/github-tools`) returns the title, description, head commit
   sha, and every file's patch, plus the right-hand lines a comment can
   be anchored to.

3. **Three passes over the same diff.** Correctness (defects with
   receipts), architecture (is the shape sound), and release risk (what
   actually blocks shipping). The prompts live in
   `@corbits/code-review`'s reviewer roster — the same three definitions
   that install as agents through the agent-directory create path, so a
   reviewer's wording exists in exactly one place.

4. **One review, posted.** The passes are combined into a single review:
   a finding two passes raise is one entry crediting both, blocking
   first, and inline comments only on lines the diff can anchor.
   `github_post_pull_request_review` posts it.

## Approval

Posting is not approval-gated. A review is a comment — it never
approves, requests changes, or merges — so it flows under the standing
grant on the GitHub connection.

## Connections

Needs the `github` connection. `CODE_REVIEW_CREDENTIAL_BINDINGS` binds
the pinned tool package's `github` handle to the tenant's credential;
without it the run says plainly that GitHub is not connected rather than
reviewing a change it could not read.

## Large pull requests

The diff read takes the first 100 changed files, and the review prompt
holds a total patch budget. When either cut applies, the prompt names
what was not shown and the review says so, rather than reporting a clean
pass over files nobody looked at.

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable: false`
(it runs on a pull-request event, not a schedule) and not seeded, since
it needs a GitHub connection to be useful.
