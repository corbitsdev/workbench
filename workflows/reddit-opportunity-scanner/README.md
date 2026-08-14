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
  skipped, never fabricated. If nothing is reachable, or nothing is
  found, the run does not just reply and stop: it calls
  `reddit_opportunity_scanner_report_no_results`
  (`./src/finalize-tool.ts`) once, persisting one honest teaching
  artifact — what was searched (or that nothing was reachable), which
  connector is missing if that's why, and what the sender should do
  next — then delivers the same account as its reply. This call needs
  no approval: nothing was selected, so there is nothing to confirm.
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

`reddit_opportunity_scanner_finalize` is declared `approval: "ask"`
(`@intx/agent`'s `ToolDeclaration`), the platform's native tool-approval
gate — identical mechanics to `@corbits/pain-point-collateral-workflow`'s
and `@corbits/collateral-generation-workflow`'s finalize tools. Calling
it suspends the run; a human approves or rejects it from the inbox; on
approval the tool actually runs, on rejection it never runs and the
model gets a synthetic "denied by approver" error, which the system
prompt turns into a calm terminal reply. See `pain-point-collateral`'s
README for the full suspend/resume account, which applies unchanged
here.

`reddit_opportunity_scanner_report_no_results` (the no-data teaching
artifact, see "What it does" above) carries no approval mark and runs
immediately: a no-data run has nothing the sender selected to confirm,
only an honest account of what the run attempted.

## Library persistence

Both tools persist through the sanctioned workflow-artifacts HTTP
surface (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`,
CL-6000) via `createWorkflowArtifact` (`./src/artifact-client.ts`,
duplicated rather than imported from `@corbits/artifact-tools` — see
that file's header for why this installable-data package never imports
another `@corbits/*` package). `reddit_opportunity_scanner_finalize`
persists each selected opportunity sequentially and, on a partial
failure, honestly names how many already persisted rather than losing
or silently claiming the whole batch failed.
`reddit_opportunity_scanner_report_no_results` persists exactly one
artifact. A successful call returns the persisted artifact's id/version
so the delivery pipeline attaches it to the reply as a Library file-part
chip (`packages/chat/src/artifact-delivery.ts`); a failed call surfaces
as an honest `isError: true` result, never a fabricated success.

## Current limits (read before deploying)

Two real gaps stand between this definition and a fully live deploy:

1. **No Firecrawl tool package.** CL-5994's dependency survey found no
   corbits/Interchange integration for site scraping. Building one is a
   separate, un-scoped piece of work — this port names `firecrawl_scrape`
   in its prompt as the tool it would use, and commits to an honest "no
   way to scrape" reply until that package exists and is pinned.
2. **No tool-package pin** (CL-5999). No production workflow builder in
   this repo threads a caller-supplied `toolPackagePins` onto a built
   definition yet. Until it lands, this definition ships with
   `tools: []`; `@corbits/reddit-tools` exists, is tested, and is ready
   to wire in the moment pinning is built. In practice this means every
   search is unreachable on a real deploy today, so the no-data teaching
   artifact (naming `scrapecreators`, the connector `@corbits/reddit-tools`
   needs) is the path most real runs will hit until pinning lands.

Neither gap is specific to this workflow; both are pre-existing platform
limits this port surfaces rather than works around.

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
with `automatable: false`, the same as every other approval-gated
single-step definition in this catalog (`pain-point-collateral`,
`collateral-generation`): a run with a mid-run approval gate is a poor
fit for unattended scheduling, the same reasoning the CL-5994 ticket's
own outcome checklist recommends for this workflow.
