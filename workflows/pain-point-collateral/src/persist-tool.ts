import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { ARTIFACT_CREATE_DEFINITION } from "@workbench/tools-artifact";

// Workflow-owned batch persist tool: `persist` was a `map` whose inner step
// was a single-piece `deterministicToolStep` (`artifact_create`). Two
// independent blockers made this un-migratable to a plain native `action`
// directly on the map's inner step:
//   1. Field rename: `artifact_create` requires `kind`, but each approved
//      piece carries the same value under `format`. The native selector
//      vocabulary (`from` / `project` / `merge` / `literal`) can only pick
//      fields through, never rename one — composing `title`/`content` (pass
//      through unrenamed) with `kind` (renamed from `format`) is not
//      expressible as a single `input` selector.
//   2. `MapPrimitive.step` is typed `StepPrimitive`, not the `Primitive`
//      union (`interchange/packages/workflow/src/definition/primitives.ts`),
//      so a native `action` cannot host a map's inner step at all;
//      independently the deploy-time capability walk's `extractAgent`
//      (`interchange/packages/workflow-deploy/src/capability-walk.ts`) only
//      reads `primitive.step.agent` for a map node, so even a same-shape
//      action inside a map would pin no tool package.
// The fix (the pattern `granola_spawn_call_runs` established for
// iteration): the tool loops over the approved pieces in plain TypeScript,
// doing the field rename itself, so `persist` becomes one native `action`.
//
// Persisting a piece is FATAL here, matching the old per-item map (no
// tolerant wrapper existed for `persist`): the loop stops at the first
// failing save and the wrapper returns an error `ToolResult`, so
// `runDeterministicToolStep` throws exactly as the old per-item map step did.

export const PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION: ToolDefinition = {
  name: "pain_point_collateral_persist_pieces",
  description:
    "Internal pain-point-collateral workflow helper. Saves every approved collateral piece as an artifact, failing the run if any save fails.",
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
  id: "@workbench/workflow-pain-point-collateral/persist-pieces-inner",
  definitions: [ARTIFACT_CREATE_DEFINITION],
});

// `index.ts`'s `generate` step comment documents the pain-point × format
// fan-out as "capped at 9" collateral pieces — a client/panel-side
// convention this batch tool never itself enforced. Enforce it here.
export const MAX_APPROVED_PIECES = 9;

function requireStringField(
  item: Record<string, unknown>,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION.name}: each item requires a non-empty "${field}"`,
    );
  }
  return value;
}

/**
 * The persist step's per-piece field mapping (including the `format` →
 * `kind` rename no native selector can express) — exported so the CL-2775
 * review→persist fidelity test asserts against the REAL mapping this tool
 * dispatches, not a hand-rolled copy. A display-fields-only row payload
 * (no `content`) now THROWS here rather than silently resolving an empty
 * artifact — a stricter guard than the old argMap-based silent-undefined
 * behavior this replaces.
 */
export function approvedPieceToArtifactCreateArgs(
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    title: requireStringField(item, "title"),
    kind: requireStringField(item, "format"),
    content: requireStringField(item, "content"),
  };
}

function createPersistPiecesTool(env: BaseEnv): AgentTool {
  const inner = artifactCreateInner(env);
  return {
    kind: "full",
    definition: PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      const items = args.approvedPieces;
      if (!Array.isArray(items)) {
        throw new Error("approvedPieces must be an array");
      }
      if (items.length > MAX_APPROVED_PIECES) {
        throw new Error(
          `${PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION.name}: approvedPieces has ${items.length} pieces, exceeding the documented cap of ${MAX_APPROVED_PIECES}`,
        );
      }
      const results: unknown[] = [];
      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each approved piece must be an object");
        }
        const item = raw as Record<string, unknown>;
        const result = await inner.run(
          {
            id: call.id,
            name: "artifact_create",
            arguments: approvedPieceToArtifactCreateArgs(item),
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
                : `${PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION.name}: item persist failed: ${JSON.stringify(result.content)}`,
          };
        }
        results.push(result.content);
      }
      return { callId: call.id, content: { results } };
    },
  };
}

export function createPainPointCollateralPersistTools(
  env: BaseEnv,
): AgentTool[] {
  return [createPersistPiecesTool(env)];
}

/** Env keys this wrapper tool needs injected — the same key the wrapped
 * package itself declares. Re-exported so `interchange-tools.ts`'s
 * `defineTool({ requires })` stays a single source of truth with this file. */
export const PERSIST_TOOL_REQUIRES = [...artifactCreateInner.requires];
