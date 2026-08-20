// The two pieces of this workflow that reach the Library engine: finalizing
// the set of Reddit opportunities the sender picked to keep, and — on an
// honest no-data run — reporting what was attempted so the sender isn't
// left with silence. Kept inside the workflow package rather than a shared
// tool package — same "workflow-specific logic lives in the definition"
// convention `pain-point-collateral`'s and `collateral-generation`'s
// finalize-tool.ts files established — neither is a reusable integration
// on its own.
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
// call to `reddit_opportunity_scanner_finalize` — so a run can never
// silently persist something the sender never confirmed.
//
// Approval mechanics: `reddit_opportunity_scanner_finalize` is declared
// `approval: "ask"`, the platform's native tool-approval gate — identical
// mechanics to `pain-point-collateral`'s and `collateral-generation`'s
// finalize tools (see that package's `finalize-tool.ts` header for the
// full suspend/resume account, which applies unchanged here).
// `reddit_opportunity_scanner_report_no_results` carries no approval mark:
// a no-data run has no sender-selected content to confirm, only an honest
// account of what the workflow attempted, so gating it behind a human
// decision would just add friction with nothing to decide.
//
// This is one `defineTool` factory declaring two tool names (the shape
// `ToolDeclaration`/`ToolBundle` both support — see
// `@intx/agent/src/tool.ts`) rather than two separate exports,
// because both share the same persistence dependency
// (`./artifact-client.ts`) and env requirements.
//
// Persistence (CL-6000): `run` below calls `createWorkflowArtifact`
// (`./artifact-client.ts`, duplicated from `@corbits/artifact-tools`'
// client rather than imported — see that file's header for why this
// installable-data package never imports another `@corbits/*` package)
// against the sanctioned workflow-artifacts HTTP surface — authenticated
// with the sidecar's own bearer token and this run's own mailbox
// address, both already present on `env`, never a database handle.
// `reddit_opportunity_scanner_finalize` persists each opportunity
// sequentially and stops at the first failure, honestly naming how many
// already persisted (the same partial-failure convention
// `collateral-generation`'s finalize tool uses for its own batch).
// `reddit_opportunity_scanner_report_no_results` persists exactly one
// artifact. A successful call returns the persisted artifact's id/version
// (single object, or `{ artifacts: [...] }` for the batch) so the delivery
// pipeline can reference it with a file part
// (`packages/chat/src/artifact-delivery.ts`); a failed call surfaces as an
// honest `isError: true` result rather than a fabricated success.

import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import { createWorkflowArtifact } from "./artifact-client";

export const REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME =
  "reddit_opportunity_scanner_finalize";

export const REDDIT_OPPORTUNITY_SCANNER_FINALIZE_DESCRIPTION =
  "Finalizes the set of human-selected Reddit opportunities from one run, pending a single human approval, and persists each as a Library artifact.";

export const REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME =
  "reddit_opportunity_scanner_report_no_results";

export const REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_DESCRIPTION =
  "Persists one honest teaching artifact for a run that found no opportunities: what was searched, which connector (if any) is missing, and what the sender should do next. Not approval-gated — nothing was selected, so there is nothing for a human to confirm.";

const ARTIFACT_KIND = "reddit-opportunity-scan";
// "status-note" is the one teaching-artifact kind shared by every
// workflow in this catalog (see each workflow's README, "Teaching-
// artifact kind" section) — a run's Library kind badge always reads
// "Status note" for a no-data run, regardless of which workflow made it.
const NO_RESULTS_ARTIFACT_KIND = "status-note";

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

/**
 * `attemptedSearches` and `missingConnectors` are free-text/id lists the
 * model fills in from what it actually tried this run — never invented.
 * `missingConnectors` may be empty: a run can reach zero results with
 * every connector connected and every search reachable.
 */
const NoResultsReportArgs = type({
  /** The target site URL the sender named for this run. */
  targetUrl: "string > 0",
  /** One line per keyword/subreddit pair actually attempted, or empty. */
  attemptedSearches: "string[]",
  /** Connector ids (e.g. "scrapecreators") this run could not reach, if any. */
  missingConnectors: "string[]",
  /** Plain-language advice for what the sender should do next. */
  nextSteps: "string > 0",
});

export type NoResultsReportArgs = typeof NoResultsReportArgs.infer;

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
 * The payload for a no-data run's teaching artifact: what was searched
 * (or that nothing was reachable), which connector is missing, and what
 * the sender should do next. Every line is drawn from `args` — nothing
 * here is invented sample data.
 */
export function buildNoResultsArtifactPayload(
  args: NoResultsReportArgs,
): ArtifactPayload {
  const searchesSection =
    args.attemptedSearches.length > 0
      ? [
          "Searches attempted:",
          ...args.attemptedSearches.map((search) => `- ${search}`),
        ].join("\n")
      : "No searches were reachable — this run could not reach Reddit before this point.";
  const connectorsSection =
    args.missingConnectors.length > 0
      ? `Missing connector(s): ${args.missingConnectors.join(", ")}`
      : "No connector is missing; every attempted search was reachable and simply found nothing.";
  return {
    title: `Reddit opportunity scan: no results for ${args.targetUrl}`,
    kind: NO_RESULTS_ARTIFACT_KIND,
    content: [
      `Target: ${args.targetUrl}`,
      "",
      searchesSection,
      "",
      connectorsSection,
      "",
      `Next steps: ${args.nextSteps}`,
    ].join("\n"),
  };
}

/**
 * The env this tool needs beyond `BaseEnv`: the sanctioned
 * workflow-artifacts credential trio, populated for every workflow step
 * (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`) — the same
 * three keys `@corbits/artifact-tools`' read-side bundle declares.
 */
export interface WorkflowArtifactEnv extends BaseEnv {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

function artifactClientConfig(env: WorkflowArtifactEnv) {
  return {
    hubArtifactsUrl: env.hubArtifactsUrl,
    sidecarToken: env.sidecarToken,
    runAddress: env.address,
  };
}

/**
 * `defineTool`'s env-DI factory shape. Needs the sanctioned
 * workflow-artifacts credential trio beyond `BaseEnv`.
 */
export const REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL =
  defineTool<WorkflowArtifactEnv>({
    id: "@corbits/workflow-reddit-opportunity-scanner/finalize",
    requires: ["hubArtifactsUrl", "sidecarToken", "address"],
    definitions: [
      { name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME, approval: "ask" },
      { name: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME },
    ],
    factory: (env) => ({
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
        {
          name: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
          description: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              targetUrl: { type: "string" },
              attemptedSearches: {
                type: "array",
                items: { type: "string" },
              },
              missingConnectors: {
                type: "array",
                items: { type: "string" },
              },
              nextSteps: { type: "string" },
            },
            required: [
              "targetUrl",
              "attemptedSearches",
              "missingConnectors",
              "nextSteps",
            ],
          },
        },
      ],
      run: async (call) => {
        if (call.name === REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME) {
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
          const persisted: {
            id: string;
            version: number;
            title: string;
            kind: string;
            persisted: true;
          }[] = [];
          for (const artifact of artifacts) {
            try {
              const created = await createWorkflowArtifact(
                artifactClientConfig(env),
                artifact,
              );
              persisted.push({
                id: created.id,
                version: created.version,
                title: artifact.title,
                kind: artifact.kind,
                persisted: true,
              });
            } catch (err) {
              return {
                callId: call.id,
                isError: true,
                content: `Failed to persist "${artifact.title}" as a Library artifact after persisting ${persisted.length} of ${artifacts.length} opportunit${artifacts.length === 1 ? "y" : "ies"}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              };
            }
          }
          return {
            callId: call.id,
            isError: false,
            content: JSON.stringify({ artifacts: persisted }),
          };
        }

        if (
          call.name === REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME
        ) {
          const parsed = NoResultsReportArgs(call.arguments);
          if (parsed instanceof type.errors) {
            return {
              callId: call.id,
              isError: true,
              content: `Invalid arguments for ${REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME}: ${parsed.summary}`,
            };
          }
          const artifact = buildNoResultsArtifactPayload(parsed);
          try {
            const created = await createWorkflowArtifact(
              artifactClientConfig(env),
              artifact,
            );
            return {
              callId: call.id,
              isError: false,
              content: JSON.stringify({
                id: created.id,
                version: created.version,
                title: artifact.title,
                kind: artifact.kind,
                persisted: true,
              }),
            };
          } catch (err) {
            return {
              callId: call.id,
              isError: true,
              content: `Failed to persist "${artifact.title}" as a Library artifact: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
          }
        }

        return {
          callId: call.id,
          isError: true,
          content: `Unknown tool: ${call.name}`,
        };
      },
    }),
  });
