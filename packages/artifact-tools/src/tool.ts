// The `artifact_list_recent` tool bundle: the agent-facing surface a
// collateral-drafting workflow needs to pick workbench artifacts as
// source material.
//
// Unlike `@corbits/granola-tools` and `@corbits/linear-tools`, this
// bundle has no per-user credential to be "not connected" — the gap it
// hits is structural, not a missing key. Tool packages run inside the
// sidecar's workflow-process child, a separate process with no database
// handle and no authenticated hub-API path (confirmed while porting
// `pain-point-collateral`'s finalize tool, CL-5995; tracked for the
// write side as CL-6000, "Workflow tools can't persist Library
// artifacts"). Listing artifacts hits the identical gap on the read
// side: there is no sanctioned path yet for a tool running in that
// child process to call the hub's `GET /artifacts` route. Rather than
// inventing a one-off credential or auth scheme to route around that —
// which would just be re-solving CL-6000 badly and in one corner — this
// tool always returns an honest, structured "not reachable yet" result.
// The moment a sanctioned workflow-tool-to-hub path lands (CL-6000), the
// real `artifact_list` call belongs here as a one-line change, same as
// `finalize-tool.ts`'s header describes for persistence.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

export const ARTIFACT_LIST_RECENT_TOOL = "artifact_list_recent";

export const ARTIFACT_LIST_RECENT_UNAVAILABLE_REASON =
  "Workbench artifacts are not reachable from a workflow tool yet — " +
  "tool packages run in a separate process with no path to the hub's " +
  "Library engine (see CL-6000). Treat this source as unavailable " +
  "rather than fabricating artifact content.";

function unavailableResult(callId: string): ToolResult {
  return {
    callId,
    isError: true,
    content: ARTIFACT_LIST_RECENT_UNAVAILABLE_REASON,
  };
}

/**
 * The `@corbits/artifact-tools` bundle factory: one tool, no env
 * requirements beyond `BaseEnv` — there is no credential to resolve,
 * only a platform gap to report honestly.
 */
export const artifactTools = defineTool<BaseEnv>({
  id: "@corbits/artifact-tools/artifact",
  requires: [],
  definitions: [{ name: ARTIFACT_LIST_RECENT_TOOL }],
  factory: () => ({
    definitions: [
      {
        name: ARTIFACT_LIST_RECENT_TOOL,
        description:
          "Lists the tenant's recent Library artifacts (title, kind, " +
          "created-at) for use as collateral source material. Currently " +
          "always returns an error result naming this source " +
          '"not reachable yet" (CL-6000) — never fabricate artifacts ' +
          "when this happens.",
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
      Promise.resolve(unavailableResult(call.id)),
  }),
});
