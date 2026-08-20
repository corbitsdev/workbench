# @corbits/code-review

The mechanism behind a multi-reviewer pull-request review: the reviewer
roster, the turn input, the parse of what a reviewer reports, the
aggregation into one review, and the run that ties them together.

## The roster

Three reviewers, each a lens rather than a whole opinion:

| Reviewer | What it judges |
| --- | --- |
| Correctness reviewer | Defects, with the file, the line, and the input that triggers them |
| Architecture reviewer | Whether the shape is sound: invariants, where a constraint is owned, what it costs later |
| Release-risk reviewer | What blocks shipping, what ships with a note, what is filed for later |

`codeReviewAgentRequests()` returns the same three as create-agent
requests, so the roster a review fans out to is the roster a person can
see and edit in the workbench.

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

## Aggregation

- A finding two reviewers raise is one entry crediting both, at the more
  severe of the two severities.
- Order is blocking, then worth fixing, then for later.
- An inline comment is made only for a line the diff reported as
  changed; every other finding stays in the body, where GitHub cannot
  reject it.
- No findings reads as a clean review, not an empty one.

## Posting

A posted review is comment-only: never an approval, a change request, or
a merge. That is why it is not approval-gated.
