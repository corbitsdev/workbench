// The code-review definition: three reviewer lenses over every pull
// request. Its blocks install the one `code-review` workflow; the
// reviewer roster itself is `@corbits/code-review`'s own
// `CODE_REVIEW_REVIEWERS` — mirrored into `agents` here rather than
// duplicated, so a reviewer's handle, name, and one-line role can never
// drift between the package that runs the review and the definition
// that describes it.
import type { WorkbenchDefinition } from "../index";
// Imported from the package's own `./reviewers` subpath, never its root
// (`@corbits/code-review`) — the root barrel also re-exports the review
// run and GitHub client, which pull in `@corbits/github-tools` and
// `@intx/agent`'s full provider surface. `reviewers.ts` itself has no
// imports at all, so this subpath keeps every consumer of this
// definition (this package's whole point) off that much heavier graph.
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review/reviewers";

export const CODE_REVIEW_TEMPLATE: WorkbenchDefinition = {
  id: "code-review",
  title: "Code review",
  promise:
    "Three reviewers read every pull request and post what they'd change.",
  blocks: [{ assetName: "code-review", version: "0.0.1" }],
  // GitHub is the one thing this template cannot work without: no
  // repository, no diff to read and nowhere to post the review.
  plugins: { required: ["github"], optional: [] },
  tools: ["@corbits/github-tools"],
  routines: [],
  webhookTriggers: [
    {
      key: "pull-request-opened",
      blockAssetName: "code-review",
      label: "Review new pull requests",
      why: "A review is worth most posted while the pull request is still open for comment, so this fires the moment GitHub says one exists rather than waiting on a clock.",
      triggerFieldKey: "pullRequestUrl",
    },
  ],
  agents: [
    ...CODE_REVIEW_REVIEWERS.map((reviewer) => ({
      handle: reviewer.handle,
      displayName: reviewer.displayName,
      blockAssetName: "code-review",
      role: reviewer.description,
    })),
  ],
  openInputs: [
    {
      key: "repos",
      label: "Which repositories?",
      placeholder: "corbitsdev/workbench",
      help: "The GitHub repositories to watch. Every new pull request there gets reviewed.",
      required: true,
      appliesToWebhookTrigger: "pull-request-opened",
    },
  ],
  onboardingSteps: [
    {
      kind: "connect-plugin",
      connectorId: "github",
      title: "Connect GitHub",
      why: "Create a token scoped to the repositories you want reviewed — that is what the reviewers will be able to read.",
    },
    {
      kind: "pick-github-repos",
      title: "Choose what gets reviewed",
      why: "Of the repositories your token reaches, these are the ones a new pull request starts a review in.",
    },
    {
      kind: "start-webhook-trigger",
      webhookTriggerKey: "pull-request-opened",
      title: "Start reviewing",
      why: "From now on, every new pull request in those repositories gets a review.",
    },
  ],
};
