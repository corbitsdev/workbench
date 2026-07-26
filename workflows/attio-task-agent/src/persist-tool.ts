import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { ARTIFACT_CREATE_DEFINITION } from "@workbench/tools-artifact";

// Workflow-owned batch persist tool: `persist` was a `map` whose inner step
// was a single-piece `deterministicToolStep` (`artifact_create`).
// `MapPrimitive.step` is typed `StepPrimitive`, not the `Primitive` union
// (`interchange/packages/workflow/src/definition/primitives.ts`), so a
// native `action` cannot host a map's inner step; the deploy-time capability
// walk's `extractAgent`
// (`interchange/packages/workflow-deploy/src/capability-walk.ts`) also only
// reads `primitive.step.agent` for a map node, so even a same-shape action
// inside a map would pin no tool package. The fix (the pattern
// `granola_spawn_call_runs` established for iteration): the tool loops over
// the approved pieces in plain TypeScript, so `persist` becomes one native
// `action`.
//
// Persisting a piece is FATAL here, matching the old per-item map (no
// tolerant wrapper existed for `persist`): the loop stops at the first
// failing save and the wrapper returns an error `ToolResult`, so
// `runDeterministicToolStep` throws exactly as the old per-item map step did.

export const ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION: ToolDefinition = {
  name: "attio_task_agent_persist_pieces",
  description:
    "Internal attio-task-agent workflow helper. Saves every approved piece as an artifact, failing the run if any save fails. The artifact kind is the planner's action type — intentionally free-form.",
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
            type: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "type", "content"],
        },
      },
    },
    required: ["approvedPieces"],
  },
};

const artifactCreateInner = defineHubBackedToolPackage({
  id: "@workbench/workflow-attio-task-agent/persist-pieces-inner",
  definitions: [ARTIFACT_CREATE_DEFINITION],
});

// The planner's system prompt (`prompts.ts`) caps `draftActions` at 4 — "AT
// MOST 4 draft actions, and prefer fewer" — and `approvedPieces` here is the
// human-reviewed subset of that same plan, so it can never legitimately
// exceed 4 either. That cap was only a prompt instruction to the model, not
// something this batch tool enforced — enforce it here too.
export const MAX_APPROVED_PIECES = 4;

function requireStringField(
  item: Record<string, unknown>,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name}: each item requires a non-empty "${field}"`,
    );
  }
  return value;
}

function createPersistPiecesTool(env: BaseEnv): AgentTool {
  const inner = artifactCreateInner(env);
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION,
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
          `${ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name}: approvedPieces has ${items.length} pieces, exceeding the documented cap of ${MAX_APPROVED_PIECES}`,
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
            arguments: {
              title: requireStringField(item, "title"),
              kind: requireStringField(item, "type"),
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
                : `${ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name}: item persist failed: ${JSON.stringify(result.content)}`,
          };
        }
        results.push(result.content);
      }
      return { callId: call.id, content: { results } };
    },
  };
}

export function createAttioTaskAgentPersistTools(env: BaseEnv): AgentTool[] {
  return [createPersistPiecesTool(env)];
}

/** Env keys this wrapper tool needs injected — the same key the wrapped
 * package itself declares. Re-exported so `interchange-tools.ts`'s
 * `defineTool({ requires })` stays a single source of truth with this file. */
export const PERSIST_TOOL_REQUIRES = [...artifactCreateInner.requires];
