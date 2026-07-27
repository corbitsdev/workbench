import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { ARTIFACT_CREATE_DEFINITION } from "@workbench/tools-artifact";

// Workflow-owned batch persist tool: `persist` was a `map` whose inner step
// was a single-opportunity `deterministicToolStep` (`artifact_create`).
// `MapPrimitive.step` is typed `StepPrimitive`, not the `Primitive` union
// (`interchange/packages/workflow/src/definition/primitives.ts`), so a
// native `action` cannot host a map's inner step; the deploy-time capability
// walk's `extractAgent`
// (`interchange/packages/workflow-deploy/src/capability-walk.ts`) also only
// reads `primitive.step.agent` for a map node, so even a same-shape action
// inside a map would pin no tool package. The fix (the pattern
// `granola_spawn_call_runs` established for iteration): the tool loops over
// the selected opportunities in plain TypeScript, so `persist` becomes one
// native `action`.
//
// Persisting an opportunity is FATAL here, matching the old per-item map (no
// tolerant wrapper existed for `persist`): the loop stops at the first
// failing save and the wrapper returns an error `ToolResult`, so
// `runDeterministicToolStep` throws exactly as the old per-item map step did.

export const REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION: ToolDefinition =
  {
    name: "reddit_opportunity_scanner_persist_items",
    description:
      "Internal reddit-opportunity-scanner workflow helper. Saves every selected opportunity as an artifact, failing the run if any save fails.",
    inputSchema: {
      type: "object",
      properties: {
        selected: {
          type: "array",
          description: "The selected opportunities to save.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string" },
            },
            required: ["title", "content"],
          },
        },
      },
      required: ["selected"],
    },
  };

const artifactCreateInner = defineHubBackedToolPackage({
  id: "@workbench/workflow-reddit-opportunity-scanner/persist-items-inner",
  definitions: [ARTIFACT_CREATE_DEFINITION],
});

// The panel caps the curated/selected batch at 12 opportunities
// (`prompts.ts`'s curate instructions, `index.ts`'s `persist` step comment).
// That cap is a client-side convention, not something the batch tool itself
// enforced — enforce it here too, so a caller that bypasses the panel still
// cannot fan this loop out past what the workflow was designed for.
export const MAX_SELECTED_OPPORTUNITIES = 12;

function requireStringField(
  item: Record<string, unknown>,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION.name}: each item requires a non-empty "${field}"`,
    );
  }
  return value;
}

/**
 * The persist step's per-opportunity field mapping — exported so the MAP-trap
 * fidelity test (`blocks.integration.test.ts`) asserts against the REAL
 * mapping this tool dispatches, not a hand-rolled copy. A field-name typo
 * here fails that test.
 */
export function opportunityToArtifactCreateArgs(
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    title: requireStringField(item, "title"),
    kind: "reddit-opportunity-scan",
    content: requireStringField(item, "content"),
  };
}

function createPersistItemsTool(env: BaseEnv): AgentTool {
  const inner = artifactCreateInner(env);
  return {
    kind: "full",
    definition: REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      const selected = args.selected;
      if (!Array.isArray(selected)) {
        throw new Error("selected must be an array");
      }
      if (selected.length > MAX_SELECTED_OPPORTUNITIES) {
        throw new Error(
          `${REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION.name}: selected has ${selected.length} opportunities, exceeding the documented cap of ${MAX_SELECTED_OPPORTUNITIES}`,
        );
      }
      const results: unknown[] = [];
      for (const raw of selected) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each selected opportunity must be an object");
        }
        const item = raw as Record<string, unknown>;
        const result = await inner.run(
          {
            id: call.id,
            name: "artifact_create",
            arguments: opportunityToArtifactCreateArgs(item),
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
                : `${REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION.name}: item persist failed: ${JSON.stringify(result.content)}`,
          };
        }
        results.push(result.content);
      }
      return { callId: call.id, content: { results } };
    },
  };
}

export function createRedditOpportunityScannerPersistTools(
  env: BaseEnv,
): AgentTool[] {
  return [createPersistItemsTool(env)];
}

/** Env keys this wrapper tool needs injected — the same key the wrapped
 * package itself declares. Re-exported so `interchange-tools.ts`'s
 * `defineTool({ requires })` stays a single source of truth with this file. */
export const PERSIST_TOOL_REQUIRES = [...artifactCreateInner.requires];
