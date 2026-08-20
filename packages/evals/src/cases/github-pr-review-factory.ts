// CL-6322 §8.2 case: "connect this GitHub organization and put every
// PR through an automated review with greybeard, cto, and critique,
// plus suggested fixes." Rewritten (CL-6340) against the product that
// actually shipped, not the chat-driven flow the case was first
// scripted around:
//
//   - The reviewer roster is `@corbits/code-review`'s three lenses
//     (architecture / correctness / release-risk), installed as agent
//     definitions when the code-review template is instantiated from
//     the seeded bench library (CL-6344/#140) — never `create_agent`
//     × 3 in chat. The human's "greybeard, cto, critique" ask maps
//     onto those lenses; the handles below are the shipped ones.
//   - Per-repo grants and the per-repo `webhook_trigger` rows are
//     minted at repo selection by the connect card's start-reviewing
//     step (CL-6345/#142) — never a chat-driven `routine_create`.
//   - On a PR event, ONE aggregated comment-only review is posted by
//     the workflow run via `github_post_pr_review` (CL-6340/#62),
//     free under the per-repo grant, with the reviewer lenses named
//     in the body for audit attribution. A merge-class action still
//     parks behind explicit human approval —
//     `outwardGitHubActionsRespectGrantBoundary` grades both halves
//     of that owner ruling together.
//
// Step 2 drives the real install (CL-6404: the `install-template` step
// rides #140's seeded-library instantiation route-for-route) and step
// 4 fires the real ingress route (`fire-webhook`). What still narrates
// instead of acting is the GitHub side: the `/complete` PAT prove and
// start-reviewing's repo listing hit real GitHub until CL-6403's
// baseUrl seam lands — README.md's scoreboard names those precisely.
// The scorers grade the world snapshot, so they go green the moment
// that seam falls — no scorer rewrite needed then.
//
// Pass 1 (this case) stops at "review posted" — outcome-ingest
// (GitHub state flowing back into memory so agents improve) is case
// two and out of scope here.
import { defineEval } from "../define-eval.ts";
import {
  agentDefinitionsHaveToolGrants,
  approvalGated,
  githubConnectedViaConnectionsLayer,
  judge,
  noBuildBeforeAnswers,
  outwardGitHubActionsRespectGrantBoundary,
  reviewCommentsAttributable,
  routineCreatedOnlyAfterOk,
  suggestedFixesStructurallyValid,
  triggerIsWebhookPerPr,
  wholeRunInspectable,
} from "../scorers/scorers.ts";
import {
  GITHUB_MERGE_PULL_REQUEST_TOOL,
  ROUTINE_CREATE_TOOL,
} from "../scorers/tool-names.ts";

const TARGET_REPO = "abklabs/workbench";

// The shipped reviewer roster (`@corbits/code-review`'s
// CODE_REVIEW_REVIEWERS): what "greybeard, cto, and critique" actually
// installs. Handles are what the agent-directory create path stores;
// display names are what `aggregateReview` renders into the posted
// review body — the attribution markers the grant-boundary scorer
// checks for.
const REVIEWER_HANDLES = [
  "architecture-reviewer",
  "correctness-reviewer",
  "release-risk-reviewer",
] as const;
const REVIEWER_DISPLAY_NAMES = [
  "Architecture reviewer",
  "Correctness reviewer",
  "Release-risk reviewer",
] as const;

export const githubPrReviewFactoryEval = defineEval({
  name: "github-pr-review-factory",
  description:
    "'connect this GitHub organization and put every PR through an " +
    "automated review with greybeard, cto, and critique, plus " +
    "suggested fixes' -> GitHub connected via the connections layer -> " +
    "code-review template instantiated from the seeded library (three " +
    "reviewer lenses + the github-pinned code-review workflow) -> " +
    "per-repo grant and webhook trigger minted at repo selection -> on " +
    "a fake pull_request.opened, one aggregated attributable review " +
    "with suggestion fences posted free under the grant, while any " +
    "merge-class action still parks -> whole run inspectable.",
  steps: [
    {
      human:
        "connect this GitHub organization and put every PR through an " +
        "automated review with greybeard, cto, and critique, plus " +
        "suggested fixes",
      expect: [
        noBuildBeforeAnswers(1),
        judge(
          "The reply asks only what only the human knows before building " +
            "anything — which org/repos, and whether a GitHub connection " +
            "already exists — never a plan-approval step (per AGENTS.md " +
            "'interview for inputs, rip on construction, gate only at the " +
            "boundary').",
        ),
      ],
    },
    {
      // The real install (CL-6404): the harness drives #140's
      // seeded-library instantiation — manifest read, workbench mint,
      // participant creation — through the same routes the picker's
      // "Create workbench" uses. Remaining red half:
      // `githubConnectedViaConnectionsLayer` needs the Plugins
      // `/:connectorId/complete` PAT prove, which still hits real
      // GitHub (CL-6403's baseUrl-seam lane).
      kind: "install-template",
      templateId: "code-review",
      expect: [
        githubConnectedViaConnectionsLayer(),
        agentDefinitionsHaveToolGrants(REVIEWER_HANDLES),
      ],
    },
    {
      human: `looks good — review ${TARGET_REPO}, wire it up`,
      expect: [
        // The shipped trigger wiring is start-reviewing's per-repo
        // webhook_trigger mint, not a chat-driven routine_create — so
        // routine_create must never fire here, and when it somehow
        // does, only after the OK.
        routineCreatedOnlyAfterOk(2),
        approvalGated([ROUTINE_CREATE_TOOL]),
        triggerIsWebhookPerPr(),
        judge(
          "The reply confirms GitHub is connected, names the three " +
            "reviewer lenses, and confirms every PR on the selected repo " +
            "now triggers a review — warm, direct, no wizard checklist.",
        ),
      ],
    },
    {
      // The harness fires a fake `pull_request.opened` delivery through
      // the REAL ingress route against whatever enabled webhook_trigger
      // start-reviewing minted (CL-6404's `fireWebhook`). While
      // start-reviewing itself stays blocked on the GitHub REST seam
      // (CL-6403), no trigger exists and the step honestly records that
      // miss, keeping these scorers red rather than crashing the run.
      kind: "fire-webhook",
      payload: {
        action: "opened",
        repository: { full_name: TARGET_REPO },
        pull_request: {
          number: 101,
          html_url: `https://github.com/${TARGET_REPO}/pull/101`,
          head: { sha: "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678" },
        },
      },
      expect: [
        reviewCommentsAttributable(REVIEWER_HANDLES),
        suggestedFixesStructurallyValid(),
        outwardGitHubActionsRespectGrantBoundary(
          TARGET_REPO,
          GITHUB_MERGE_PULL_REQUEST_TOOL,
          REVIEWER_DISPLAY_NAMES,
        ),
        wholeRunInspectable(),
      ],
    },
  ],
});
