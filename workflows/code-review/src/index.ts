// The code-review workflow: a pull request arrives, three reviewer
// lenses read the diff, and one review is posted back on the pull
// request.
//
// One step, one agent — the shape every definition in this catalog
// commits to, and the shape the webhook ingress can launch today
// (`@corbits/webhook-triggers` launches a folded, single-step definition
// through `@corbits/folded-runs`). A GitHub `pull_request` webhook
// registered against this definition renders its input template into the
// run's first message, so the trigger is a real PR event, not a poll.
//
// The three reviewer lenses are not restated here: their prompts come
// from `@corbits/code-review`, the same definitions installed as agents
// through the agent-directory create path, so a person editing a
// reviewer edits one prompt rather than two. Aggregation rules — dedupe
// what the lenses agree on, blocking first, anchor inline comments only
// to lines the diff reported — mirror that package's `aggregateReview`,
// which is the tested statement of the same contract.
//
// Posting is not approval-gated (owner ruling): a review is a comment,
// so it flows under the standing grant on the GitHub connection. The
// definition never approves, requests changes, or merges.
//
// Tool-package pins (CL-5999): `@intx/agent`'s `defineAgent` still does
// not accept a `toolPackagePins` field on its authoring-time config, so
// the agent below is built against `AgentDefinition`'s own type, which
// carries the field — matching every sibling definition in this catalog.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { CredentialBinding } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review";

export const CODE_REVIEW_WORKFLOW_ID = "wf_code_review";
export const CODE_REVIEW_STEP_ID = "code-review";

/** The tool packages this definition pins: GitHub reach, nothing else. */
export const CODE_REVIEW_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/github-tools", version: "0.0.6" },
];

/** Binds the pinned package's "github" handle to the tenant's connection. */
export const CODE_REVIEW_CREDENTIAL_BINDINGS: readonly CredentialBinding[] = [
  {
    package: "@corbits/github-tools",
    handle: "github",
    provider: "github",
    locator: "tenant",
  },
];

/**
 * The input template a GitHub `pull_request` webhook registers with, so
 * the run's first message names the pull request the event is about.
 */
export const CODE_REVIEW_WEBHOOK_INPUT_TEMPLATE =
  "Review this pull request: {{pull_request.html_url}}";

const REVIEWER_PASSES = CODE_REVIEW_REVIEWERS.map(
  (reviewer, index) =>
    `### Pass ${String(index + 1)}: ${reviewer.displayName}\n` +
    reviewer.systemPrompt,
).join("\n\n");

export const CODE_REVIEW_SYSTEM_PROMPT =
  "You review pull requests. A message names one pull request; you read " +
  "it, review it under three separate lenses, and post one review back " +
  "on it.\n" +
  "\n" +
  "## Reading the change\n" +
  "Call `github_pull_request_diff` with the pull-request URL from the " +
  "message. It gives you the title, the description, the head commit " +
  "sha, and each file's patch with the right-hand lines a comment can " +
  "be anchored to. If the message names no pull-request URL, or the " +
  "call comes back not connected, say so plainly in one sentence and " +
  "stop — never review a change you could not read.\n" +
  "\n" +
  "## The three passes\n" +
  "Make each pass separately, in order, over the same diff. Do not let " +
  "one pass answer for another: a pass that has nothing to raise says " +
  "so.\n" +
  "\n" +
  REVIEWER_PASSES +
  "\n" +
  "\n" +
  "## The one review\n" +
  "Combine the three passes into a single review. A finding two passes " +
  "raise is one entry crediting both. Order the entries blocking " +
  "first, then worth fixing, then for later. Say what each pass looked " +
  "at in one line, and name any pass that came up empty. Never invent " +
  "a finding to fill a section, and never repeat the whole diff back.\n" +
  "\n" +
  "## Posting it\n" +
  "Call `github_post_pr_review` exactly once, with the pull " +
  "request's URL, the head commit sha the diff reported, the combined " +
  "review as the body, and inline comments only for findings anchored " +
  "to a line that diff reported for that file — every other finding " +
  "belongs in the body. Then reply with a two-line summary: what you " +
  "posted, and the counts by severity. You are posting a comment, not " +
  "a verdict: never approve, request changes, or merge.";

export interface CodeReviewWorkflowInput {
  /** The deployment's mail address; each inbound message is one review. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the code-review definition. One step, on purpose: it is the
 * shape the webhook ingress can launch, and it keeps the three passes in
 * one agent's context so the combined review is written from all three
 * rather than stitched from summaries.
 */
export function buildCodeReviewWorkflow(
  input: CodeReviewWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildCodeReviewWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildCodeReviewWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: CODE_REVIEW_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      "code-review": step({
        agent: {
          id: CODE_REVIEW_STEP_ID,
          description:
            "Reviews a pull request under three lenses and posts one " +
            "review back on it",
          systemPrompt: CODE_REVIEW_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: CODE_REVIEW_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
        timeout: input.turnTimeoutMs,
        triggers: "unbounded",
      }),
    },
  });
}

/**
 * Serializes the definition to the JSON a workflow asset carries. A
 * value JSON would drop or mangle is a loud error naming its path
 * instead of a corrupted asset.
 */
export function serializeCodeReviewWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}
