# @corbits/reddit-opportunity-scanner-workflow

Turns one target website into a short list of scored Reddit
opportunities — posts worth engaging with for outreach or content ideas
— with a search-plan review and one human approval before anything is
finalized (CL-5994, ported from `gtm-workbench`'s
`workflows/reddit-opportunity-scanner`, child of CL-5987).

## What it does

One step, one agent, matching every other definition in this catalog.
The system prompt commits it to:

- **Intake**: a target website URL, named by the sender. Asks for one
  if none is given; never scans a site the sender did not name.
- **Scraping**: `firecrawl_scrape` (when available) fetches the site's
  content. No Firecrawl tool package exists in this workspace yet (see
  "Current limits" below) — this is out of scope for CL-5994, which owns
  the Reddit tooling only.
- **Analysis**: infers what the business sells and a candidate list of
  Reddit search keywords and subreddits.
- **Search-plan review**: presents the candidates and a business summary
  to the sender, and asks them to edit or approve the list. Wait for an
  answer; nothing is searched before this.
- **Searching**: `reddit_subreddit_search` (or `reddit_search` for a
  keyword with no specific subreddit) per approved pair, via
  `@corbits/reddit-tools`. A failed search is reported plainly and
  skipped, never fabricated; if nothing is reachable or nothing is
  found, the run says so and stops.
- **Ranking**: scores every result 1 (weak fit) to 5 (explicit buying
  signal or urgent pain), with a short engagement brief per opportunity.
- **Opportunity selection**: presents the ranked opportunities and asks
  which to keep. Wait for an answer.
- **Finalizing**: exactly one call to `reddit_opportunity_scanner_finalize`
  (`./src/finalize-tool.ts`) with every selected opportunity, gated
  behind a single human approval.

## Gate consolidation

`gtm-workbench`'s original implementation suspended for a human **twice**
in sequence: a search-plan review and an opportunity-selection review.
That shape came from the OG's step-graph architecture (`awaitSignal`
steps), which had no other way to pause for input — neither was an
independent approval decision.

Both are ordinary questions a chat-native agent asks in the course of one
conversation — matching the same consolidation
`@corbits/collateral-generation-workflow` (CL-5996) applied to its own
multi-gate OG. This port keeps the same conversation shape but
**consolidates to one real approval gate**: finalizing the opportunities
the sender selected, all at once, in a single
`reddit_opportunity_scanner_finalize` call.

**Known limit versus the OG**: the OG's selection step was a dedicated
edit UI (`reviewList`) letting the sender pick any subset of scored
opportunities. This port's platform approval gate is binary — approve or
deny the exact set the sender named in conversation — so "selection" is
approve-all-named/deny-all, not per-item editing at the approval step
itself. The per-item pick still happens, just as the preceding
conversational turn rather than at the gate.

## Approval mechanics

Identical to `@corbits/pain-point-collateral-workflow`'s and
`@corbits/collateral-generation-workflow`'s finalize tools:
`reddit_opportunity_scanner_finalize` is declared `approval: "ask"`
(`@intx/agent`'s `ToolDeclaration`), the platform's native tool-approval
gate. Calling it suspends the run; a human approves or rejects it from
the inbox; on approval the tool actually runs, on rejection it never
runs and the model gets a synthetic "denied by approver" error, which
the system prompt turns into a calm terminal reply. See
`pain-point-collateral`'s README for the full suspend/resume account,
which applies unchanged here.

## Current limits (read before deploying)

Three real gaps stand between this definition and a fully live deploy:

1. **No Firecrawl tool package.** CL-5994's dependency survey found no
   corbits/Interchange integration for site scraping. Building one is a
   separate, un-scoped piece of work — this port names `firecrawl_scrape`
   in its prompt as the tool it would use, and commits to an honest "no
   way to scrape" reply until that package exists and is pinned.
2. **No tool-package pin** (CL-5999). No production workflow builder in
   this repo threads a caller-supplied `toolPackagePins` onto a built
   definition yet. Until it lands, this definition ships with
   `tools: []`; `@corbits/reddit-tools` exists, is tested, and is ready
   to wire in the moment pinning is built.
3. **No Library-write path from a workflow tool** (CL-6000).
   `finalize-tool.ts`'s `run` builds the exact `{ title, kind, content }`
   payload each selected opportunity needs and returns them, `persisted:
false`, rather than fabricating Library rows. The finalized
   opportunities still reach the human in the delivered chat reply —
   they are just not yet Library artifacts with file-part chips.

None of the three gaps are specific to this workflow; all are
pre-existing platform limits this port surfaces rather than works around.

## Usage

```ts
import {
  buildRedditOpportunityScannerWorkflow,
  serializeRedditOpportunityScannerWorkflow,
} from "@corbits/reddit-opportunity-scanner-workflow";

const definition = buildRedditOpportunityScannerWorkflow({
  triggerAddress: "reddit-opportunity-scanner@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
});

const json = serializeRedditOpportunityScannerWorkflow(definition);
```

Pin `@corbits/reddit-tools` on the deployment for the agent to reach
real Reddit search results — without a pin, every search call is simply
absent and the run honestly reports Reddit as not reachable (see that
package's README for its credential requirement).

Registered in `@corbits/workflow-catalog` as `reddit-opportunity-scanner`
with `automatable: true`. **Read this before deploying**: every other
approval-gated single-step definition in this catalog
(`pain-point-collateral`, `collateral-generation`) is registered
`automatable: false`, on the reasoning that a run with a mid-run approval
gate is a poor fit for unattended scheduling — the CL-5994 ticket's own
outcome checklist recommends the same for this workflow. This port sets
`automatable: true` on explicit direction from the workflow's owner, on
the theory that a routine can still fire this on a schedule and simply
leave each run parked at the approval gate for a human to pick up — the
same way a scheduled run can wait on any inbox item. Confirm this is the
intended tradeoff before wiring it into the Routines picker; flipping it
back to `false` is a one-line change here and in
`packages/workflow-catalog/src/index.ts`.
