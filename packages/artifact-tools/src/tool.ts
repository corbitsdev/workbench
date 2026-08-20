// The `artifact_list_recent` tool bundle: the agent-facing surface a
// collateral-drafting workflow needs to pick workbench artifacts as
// source material.
//
// Real as of CL-6000: calls `listRecentWorkflowArtifacts` (`./client.ts`)
// against the sanctioned workflow-artifacts HTTP surface
// (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`),
// authenticating with the sidecar's own bearer token and the run's own
// mailbox address — both already reach a workflow-process child's tool
// env (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`), so
// this bundle needs no per-user credential and never touches a database
// handle. A transport, HTTP, or shape failure comes back as a completed
// `ToolResult` with `isError: true`, same convention as
// `@corbits/linear-tools`/`@corbits/granola-tools` — never fabricate
// artifacts when the call fails.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { listRecentWorkflowArtifacts } from "./client";

export const ARTIFACT_LIST_RECENT_TOOL = "artifact_list_recent";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach credential. */
export interface WorkflowArtifactEnv extends BaseEnv {
  readonly hubArtifactsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

async function runArtifactListRecent(
  env: WorkflowArtifactEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const limitArg = call.arguments["limit"];
  const limit = typeof limitArg === "number" ? limitArg : undefined;
  try {
    const artifacts = await listRecentWorkflowArtifacts(
      {
        hubArtifactsUrl: env.hubArtifactsUrl,
        sidecarToken: env.sidecarToken,
        runAddress: env.address,
      },
      limit !== undefined ? { limit } : {},
    );
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({ artifacts }),
    };
  } catch (err) {
    return {
      callId: call.id,
      isError: true,
      content: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The `@corbits/artifact-tools` bundle factory: one tool, three env keys
 * — the sanctioned CL-6000 path, not a per-user credential.
 */
export const artifactTools = defineTool<WorkflowArtifactEnv>({
  id: "@corbits/artifact-tools/artifact",
  requires: ["hubArtifactsUrl", "sidecarToken", "address"],
  definitions: [{ name: ARTIFACT_LIST_RECENT_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: ARTIFACT_LIST_RECENT_TOOL,
        description:
          "Lists the tenant's recent Library artifacts (id, title, kind, " +
          "created-at) for use as collateral source material. Returns an " +
          "error result naming the failure when the Library engine is " +
          "unreachable — never fabricate artifacts when this happens.",
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
    run: (call: ToolCall, _signal: AbortSignal) =>
      runArtifactListRecent(env, call),
  }),
});
