import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { ARTIFACT_CREATE_DEFINITION } from "@workbench/tools-artifact";

// Workflow-owned batch persist tool: `persist` / `persist-after-regen` were
// each a `map` whose inner step was a single-piece `deterministicToolStep`
// (`artifact_create`). Same structural blocker as `fetch-tools.ts` (a map's
// inner step cannot be a native `action`) and the same fix: the tool loops
// over the approved pieces in plain TypeScript, so each step becomes one
// `action`. Both workflow steps share this ONE tool — they differ only in
// which awaitSignal's output feeds them, not in what they do.
//
// Persisting a piece is FATAL here, matching the old per-item map (no
// tolerant wrapper existed for `persist`): the loop stops at the first
// failing save and the wrapper returns an error `ToolResult`, so
// `runDeterministicToolStep` throws exactly as the old per-item map step did.

export const MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_persist_pieces",
    description:
      "Internal multi-source-collateral workflow helper. Saves every approved collateral piece as an artifact, failing the run if any save fails.",
    inputSchema: {
      type: "object",
      properties: {
        approvedPieces: {
          type: "array",
          description: "The approved pieces to save.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              format: { type: "string" },
              content: { type: "string" },
            },
            required: ["title", "format", "content"],
          },
        },
      },
      required: ["approvedPieces"],
    },
  };

const artifactCreateInner = defineHubBackedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/persist-pieces-inner",
  definitions: [ARTIFACT_CREATE_DEFINITION],
});

function coerceItems(args: Record<string, unknown>): Record<string, unknown>[] {
  const items = args.approvedPieces;
  if (!Array.isArray(items)) {
    throw new Error("approvedPieces must be an array");
  }
  return items.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("each item must be an object");
    }
    return item as Record<string, unknown>;
  });
}

function requireStringField(
  item: Record<string, unknown>,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION.name}: each item requires a non-empty "${field}"`,
    );
  }
  return value;
}

function createPersistPiecesTool(env: BaseEnv): AgentTool {
  const inner = artifactCreateInner(env);
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      const items = coerceItems(args);
      const results: unknown[] = [];
      for (const item of items) {
        const result: ToolResult = await inner.run(
          {
            id: call.id,
            name: "artifact_create",
            arguments: {
              title: requireStringField(item, "title"),
              kind: requireStringField(item, "format"),
              content: requireStringField(item, "content"),
            },
          },
          signal,
        );
        if (result.isError === true) {
          return {
            callId: call.id,
            isError: true,
            content:
              typeof result.content === "string"
                ? result.content
                : `${MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION.name}: item persist failed: ${JSON.stringify(result.content)}`,
          };
        }
        results.push(result.content);
      }
      return { callId: call.id, content: { results } };
    },
  };
}

export function createMultiSourceCollateralPersistTools(
  env: BaseEnv,
): AgentTool[] {
  return [createPersistPiecesTool(env)];
}

/** Env keys this wrapper tool needs injected — the same key the wrapped
 * package itself declares. Re-exported so `interchange-tools.ts`'s
 * `defineTool({ requires })` stays a single source of truth with this file. */
export const PERSIST_TOOLS_REQUIRES = [...artifactCreateInner.requires];
