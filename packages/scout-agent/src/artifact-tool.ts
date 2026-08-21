// Scout's artifact tools: `save_artifact` (persist, gated by human
// approval — every external side effect sits behind approval per
// AGENTS.md) and `list_recent_artifacts` (read-only recall). Kept
// inside this package rather than a shared tool package, matching
// `workflows/last-30-days-research/src/finalize-tool.ts`'s convention:
// this is Scout-specific logic, not a reusable integration on its own.
//
// This is narrower than the original Scout's `artifacts` tool, which
// backed `artifact-search`/`artifact-read` against its own hub API with
// company/kind filtering and pagination. The workbench workflow-artifacts
// HTTP surface (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`)
// only offers create and list-recent, so that's what these two tools do —
// see this package's README for the gap.
import { type } from "arktype";
import { defineTool, type BaseEnv } from "@intx/agent";
import {
  createScoutArtifact,
  listRecentScoutArtifacts,
} from "./artifact-client";

export const SCOUT_ARTIFACT_SAVE_TOOL = "save_artifact";
export const SCOUT_ARTIFACT_LIST_TOOL = "list_recent_artifacts";

const SaveArgs = type({
  title: "string > 0",
  content: "string > 0",
});

export interface ScoutArtifactEnv extends BaseEnv {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

function clientConfig(env: ScoutArtifactEnv) {
  return {
    hubArtifactsUrl: env.hubArtifactsUrl,
    sidecarToken: env.sidecarToken,
    runAddress: env.address,
  };
}

/**
 * The `@corbits/scout-agent` artifact bundle: one write tool gated by
 * human approval, one read-only recall tool.
 */
export const scoutArtifactTools = defineTool<ScoutArtifactEnv>({
  id: "@corbits/scout-agent/artifacts",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [
    { name: SCOUT_ARTIFACT_SAVE_TOOL, approval: "ask" },
    { name: SCOUT_ARTIFACT_LIST_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: SCOUT_ARTIFACT_SAVE_TOOL,
        description:
          "Persists a research write-up as a Library artifact, pending " +
          "human approval. Use when the user asks for a write-up, brief, " +
          "or summary worth keeping.",
        approval: "ask",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "A short title." },
            content: {
              type: "string",
              description: "The write-up's full content.",
            },
          },
          required: ["title", "content"],
        },
      },
      {
        name: SCOUT_ARTIFACT_LIST_TOOL,
        description:
          "Lists the tenant's most recently saved Library artifacts, " +
          "most recent first.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of artifacts to return.",
            },
          },
        },
      },
    ],
    run: async (call) => {
      switch (call.name) {
        case SCOUT_ARTIFACT_SAVE_TOOL: {
          const parsed = SaveArgs(call.arguments);
          if (parsed instanceof type.errors) {
            return {
              callId: call.id,
              isError: true,
              content: `Invalid arguments for ${SCOUT_ARTIFACT_SAVE_TOOL}: ${parsed.summary}`,
            };
          }
          try {
            const created = await createScoutArtifact(clientConfig(env), {
              title: parsed.title,
              kind: "text",
              content: parsed.content,
            });
            return {
              callId: call.id,
              isError: false,
              content: JSON.stringify({
                id: created.id,
                version: created.version,
                title: parsed.title,
                persisted: true,
              }),
            };
          } catch (err) {
            return {
              callId: call.id,
              isError: true,
              content: `Failed to persist "${parsed.title}" as a Library artifact: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
          }
        }
        case SCOUT_ARTIFACT_LIST_TOOL: {
          const limitArg = call.arguments["limit"];
          const limit = typeof limitArg === "number" ? limitArg : undefined;
          try {
            const items = await listRecentScoutArtifacts(
              clientConfig(env),
              limit !== undefined ? { limit } : {},
            );
            return {
              callId: call.id,
              isError: false,
              content: JSON.stringify({ items }),
            };
          } catch (err) {
            return {
              callId: call.id,
              isError: true,
              content: err instanceof Error ? err.message : String(err),
            };
          }
        }
        default:
          return {
            callId: call.id,
            isError: true,
            content: `@corbits/scout-agent: unknown tool "${call.name}"`,
          };
      }
    },
  }),
});
