// The one piece of this workflow gated by human approval: finalizing the
// set of Reddit opportunities the sender picked to keep. Kept inside the
// workflow package rather than a shared tool package — same
// "workflow-specific logic lives in the definition" convention
// `pain-point-collateral`'s and `collateral-generation`'s finalize-tool.ts
// files established — this is not a reusable integration on its own.
//
// Gate consolidation (CL-5994): the OG `gtm-workbench` implementation
// suspended for a human twice — once to edit/approve the candidate
// keyword+subreddit search plan, and once to pick which ranked
// opportunities to keep. The first of those is an ordinary conversational
// turn here (present the plan, wait for the sender's edits or approval —
// see `./index.ts`'s system prompt), the same consolidation
// `collateral-generation` (CL-5996) applied to its own multi-gate OG. The
// opportunity pick still happens in conversation too, but this port keeps
// exactly one real platform approval gate on top of it: finalizing the
// opportunities the sender actually chose to keep, all at once, as one
// call to this tool — so a run can never silently persist something the
// sender never confirmed.
//
// Approval mechanics: identical to `pain-point-collateral`'s and
// `collateral-generation`'s finalize tools — `definitions` marks this
// tool's one definition `approval: "ask"`, the platform's native
// tool-approval gate. Calling it suspends the run and creates a real
// `approval` row; only executes once a human approves it. See
// `pain-point-collateral`'s `finalize-tool.ts` header for the full
// suspend/resume account, which applies unchanged here.
//
// Known platform gap (same category as pain-point-collateral and
// collateral-generation, tracked as CL-6000): no workflow tool package in
// this repo can reach the hub's database or its authenticated HTTP API
// today, so `run` below cannot call `@corbits/artifacts`' `artifact_create`
// and persist a Library row per opportunity yet. It builds the exact
// payload each call needs and returns them, `persisted: false`, so wiring
// the real calls in is a one-line loop the moment that path lands, not a
// redesign.

import { type } from "arktype";
import { defineTool } from "@intx/agent";

export const REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME =
  "reddit_opportunity_scanner_finalize";

export const REDDIT_OPPORTUNITY_SCANNER_FINALIZE_DESCRIPTION =
  "Finalizes the set of human-selected Reddit opportunities from one run, pending a single human approval, and prepares each as a Library artifact.";

const ARTIFACT_KIND = "reddit-opportunity-scan";

const RedditOpportunity = type({
  /** Short, human-facing title for the opportunity. */
  title: "string > 0",
  /** Subreddit name, without "r/", e.g. "startups". */
  subreddit: "string > 0",
  /** Permalink to the Reddit post. */
  url: "string > 0",
  /** 1 (weak fit) to 5 (strong buying signal or urgent pain). */
  score: "1 <= number <= 5",
  /** Why this post is worth engaging with. */
  whyItMatters: "string > 0",
  /** The drafted engagement brief: suggested angle, talking points, etc. */
  content: "string > 0",
});

const FinalizeArgs = type({
  opportunities: RedditOpportunity.array(),
});

export type FinalizeArgs = typeof FinalizeArgs.infer;
export type RedditOpportunity = typeof RedditOpportunity.infer;

export type ArtifactPayload = {
  title: string;
  kind: string;
  content: string;
};

/**
 * The payload `@corbits/artifacts`' `artifact_create` tool expects
 * (`{ title, kind, content }`) for one opportunity — `kind` is fixed at
 * `"reddit-opportunity-scan"` so every persisted opportunity from this
 * workflow is recognizable as one, regardless of subreddit or score.
 */
export function buildArtifactPayloads(
  args: FinalizeArgs,
): readonly ArtifactPayload[] {
  return args.opportunities.map((opportunity) => ({
    title: opportunity.title,
    kind: ARTIFACT_KIND,
    content: [
      `Subreddit: r/${opportunity.subreddit}`,
      `Score: ${opportunity.score}/5`,
      `URL: ${opportunity.url}`,
      "",
      `Why it matters: ${opportunity.whyItMatters}`,
      "",
      opportunity.content,
    ].join("\n"),
  }));
}

/**
 * `defineTool`'s env-DI factory shape. This tool needs nothing beyond
 * `BaseEnv`, so `requires` is empty.
 */
export const REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL = defineTool({
  id: "@corbits/workflow-reddit-opportunity-scanner/finalize",
  requires: [],
  definitions: [
    {
      name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
      approval: "ask",
    },
  ],
  factory: () => ({
    definitions: [
      {
        name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
        description: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            opportunities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  subreddit: { type: "string" },
                  url: { type: "string" },
                  score: { type: "number" },
                  whyItMatters: { type: "string" },
                  content: { type: "string" },
                },
                required: [
                  "title",
                  "subreddit",
                  "url",
                  "score",
                  "whyItMatters",
                  "content",
                ],
              },
            },
          },
          required: ["opportunities"],
        },
      },
    ],
    run: async (call) => {
      const parsed = FinalizeArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          isError: true,
          content: `Invalid arguments for ${REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME}: ${parsed.summary}`,
        };
      }
      if (parsed.opportunities.length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: `${REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME} requires at least one selected opportunity`,
        };
      }
      const artifacts = buildArtifactPayloads(parsed);
      return {
        callId: call.id,
        isError: false,
        content: JSON.stringify({
          artifacts: artifacts.map((artifact) => ({
            title: artifact.title,
            content: artifact.content,
            persisted: false,
            persistedReason:
              "workflow tool packages cannot reach the Library engine yet; see this file's header comment",
          })),
        }),
      };
    },
  }),
});
