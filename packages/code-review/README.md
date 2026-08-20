# @corbits/code-review

The mechanism behind a multi-reviewer pull-request review: the reviewer
roster, the turn input, the parse of what a reviewer reports, the
aggregation into one review, and the run that ties them together.

## The roster

Three reviewers, each a lens rather than a whole opinion:

| Reviewer              | What it judges                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Correctness reviewer  | Defects, with the file, the line, and the input that triggers them                       |
| Architecture reviewer | Whether the shape is sound: invariants, where a constraint is owned, what it costs later |
| Release-risk reviewer | What blocks shipping, what ships with a note, what is filed for later                    |

`codeReviewAgentRequests()` returns the same three as create-agent
requests, so the roster a review fans out to is the roster a person can
see and edit in the workbench.

## The report contract

Every reviewer replies under `REVIEWER_REPORT_CONTRACT`
(`src/reviewers.ts`), parsed by `parseReviewerReport` against an arktype
schema (`src/report.ts`). A reply outside the shape is a named parse
failure, never coerced into an empty report.

- **At most 5 findings per reviewer.** The prompt asks for the ones that
  matter most, not a full list — noise crowds out the real findings.
- **Severity is triaged, not defaulted.** `blocking` is a defect, a
  broken invariant, or a signature drift a caller depends on — something
  that should not ship as-is. `should-fix` is real but not urgent.
  `later` is a good idea with no urgency. The prompt states the bar for
  each so a reviewer cannot mark everything blocking to be read first.
- **Noise is suppressed in the prompt, not filtered after the fact.**
  Typos, docstring wording, import ordering, and formatting nits are
  told to reviewers to skip outright — never reported even as `later`.
- **`existingCode`/`suggestedFix` is a before/after code pair, never
  prose.** `existingCode` is the exact lines quoted from the diff;
  `suggestedFix` is the literal replacement. Aggregation only renders a
  `\`\`\`suggestion\`\`\``fence when`existingCode`is verified against
the diff at that finding's file — a finding whose`suggestedFix`is
prose, or whose`existingCode` cannot be found in the diff, keeps its
  text and drops the fence rather than posting a broken commit
  suggestion.

`./reviewers` and `./agent-requests` are also exported as their own
subpaths (`@corbits/code-review/reviewers`,
`@corbits/code-review/agent-requests`), separate from the package root.
Both files have zero imports of their own; the root also re-exports the
review run and GitHub client, which pull in `@corbits/github-tools` and
`@intx/agent`'s full provider surface. `@corbits/workflow-catalog`'s
`CODE_REVIEW_TEMPLATE` (CL-6344) imports the roster through these
subpaths for exactly that reason — see its own module doc.

## The run

```ts
const result = await runPullRequestReview(
  {
    github: createGitHubReviewClient({ apiKey: token }),
    runReviewerTurn: ({ reviewer, prompt }) => askModel(reviewer, prompt),
  },
  { owner: "acme", repo: "widgets", number: 7 },
);
```

One diff read, one turn per reviewer, one review posted at the head sha.
GitHub reach and the reviewer turn are seams: the host that owns the
connection's credential and inference supplies them, which is also why
the whole loop is testable without a network.

A reviewer that fails or replies outside the report shape does not fail
the review — the posted review names it under "Reviewers that did not
report", so a partial review never reads as a complete one.

The result is `{ skipped: true, reason }` when the pull request's author
reads as a bot login (`isBotAuthor`, `src/bot-guard.ts`) — no inference
runs and nothing is posted, so a bot pushing a change can never trigger
a review that something downstream reacts to.

## Aggregation

- A finding two reviewers raise is one entry crediting both, at the more
  severe of the two severities, keyed by fingerprint (see below) rather
  than an exact string match.
- Order is blocking, then worth fixing, then for later.
- An inline comment is made only for a line the diff reported as
  changed; every other finding stays in the body, where GitHub cannot
  reject it.
- No findings reads as a clean review, not an empty one.

## Fingerprints and re-runs

Every finding gets a stable id — `fingerprintOf` (`src/fingerprint.ts`)
SHA-256 hashes its file, line, and normalized summary — embedded as an
HTML comment marker in the posted text (invisible in rendered markdown).
Aggregation dedupes on this fingerprint, which is what lets two lenses
that raise the same problem in different words still collapse into one
entry.

`runPullRequestReview` reads back every comment already posted on the
pull request before aggregating, and `aggregateReview`'s third argument
drops any finding whose fingerprint is already out there. A re-run —
after a `synchronize`, for instance — never raises a finding it already
raised.

## Posting

A posted review is comment-only: never an approval, a change request, or
a merge. That is why it is not approval-gated.
