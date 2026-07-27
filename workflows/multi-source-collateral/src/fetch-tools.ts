import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
} from "@workbench/tool-credentials/factory";
import { ARTIFACT_READ_DEFINITION } from "@workbench/tools-artifact";
import { GRANOLA_HUB_TOOLS } from "@workbench/tools-granola";
import { LINEAR_HUB_TOOLS } from "@workbench/tools-linear";

// Workflow-owned batch fetch tools: `fetch-artifacts` / `fetch-notes` /
// `fetch-issues` were each a `map` whose inner step was a single-item
// `deterministicToolStep` (`artifact_read` / `granola_get_note` /
// `linear_get_issue`). `MapPrimitive.step` is typed `StepPrimitive`, not the
// `Primitive` union (`interchange/packages/workflow/src/definition/
// primitives.ts`), so a native `action` cannot host a map's inner step; the
// deploy-time capability walk's `extractAgent`
// (`interchange/packages/workflow-deploy/src/capability-walk.ts`) also only
// reads `primitive.step.agent` for a map node, so even a same-shape action
// inside a map would pin no tool package. The fix (the pattern
// `granola_spawn_call_runs` established for iteration): each tool loops over
// its own items array in plain TypeScript, so the workflow step becomes one
// `action` instead of a map.
//
// A single fetch failing here is FATAL — unlike gamma-presentation-creator's
// same-named fetch, which tolerates a missing source because sourceless
// generation is supported there. This workflow requires every picked source
// to actually load, so the loop stops at the first failing item and the
// wrapper returns an error `ToolResult`, letting `runDeterministicToolStep`
// throw exactly as the old per-item map step did.

function coerceItems(
  args: Record<string, unknown>,
  field: string,
): Record<string, unknown>[] {
  const items = args[field];
  if (!Array.isArray(items)) {
    throw new Error(`${field} must be an array`);
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
  toolName: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}: each item requires a non-empty "${field}"`);
  }
  return value;
}

export const MULTI_SOURCE_COLLATERAL_FETCH_ARTIFACTS_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_fetch_artifacts",
    description:
      "Internal multi-source-collateral workflow helper. Loads every chosen artifact by id, failing the run if any load fails.",
    inputSchema: {
      type: "object",
      properties: {
        artifactItems: {
          type: "array",
          description: "The artifact items chosen on the sources gate.",
          items: {
            type: "object",
            properties: { artifactId: { type: "string" } },
            required: ["artifactId"],
          },
        },
      },
      required: ["artifactItems"],
    },
  };

export const MULTI_SOURCE_COLLATERAL_FETCH_NOTES_DEFINITION: ToolDefinition = {
  name: "multi_source_collateral_fetch_notes",
  description:
    "Internal multi-source-collateral workflow helper. Loads every chosen Granola call note by id, failing the run if any load fails.",
  inputSchema: {
    type: "object",
    properties: {
      noteItems: {
        type: "array",
        description: "The note items chosen on the sources gate.",
        items: {
          type: "object",
          properties: { noteId: { type: "string" } },
          required: ["noteId"],
        },
      },
    },
    required: ["noteItems"],
  },
};

export const MULTI_SOURCE_COLLATERAL_FETCH_ISSUES_DEFINITION: ToolDefinition = {
  name: "multi_source_collateral_fetch_issues",
  description:
    "Internal multi-source-collateral workflow helper. Loads every chosen Linear issue by id, failing the run if any load fails.",
  inputSchema: {
    type: "object",
    properties: {
      issueItems: {
        type: "array",
        description: "The issue items chosen on the sources gate.",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    required: ["issueItems"],
  },
};

// `LINEAR_HUB_TOOLS`/`GRANOLA_HUB_TOOLS` are keyed registries declared as
// `Record<string, Entry>`, so indexing them by a literal key still types as
// `Entry | undefined` under `noUncheckedIndexedAccess` — this asserts the
// entry the package itself guarantees exists (a registry ever dropping a
// name it advertises is a build-time-catchable regression, not a runtime
// possibility this wrapper needs to degrade for).
function requireEntry<T>(entry: T | undefined, name: string): T {
  if (entry === undefined) {
    throw new Error(`hub tool entry "${name}" is not registered`);
  }
  return entry;
}

const artifactReadInner = defineHubBackedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/fetch-artifacts-inner",
  definitions: [ARTIFACT_READ_DEFINITION],
});

const granolaGetNoteInner = defineCredentialedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/fetch-notes-inner",
  provider: "granola",
  entries: {
    granola_get_note: requireEntry(
      GRANOLA_HUB_TOOLS.granola_get_note,
      "granola_get_note",
    ),
  },
});

const linearGetIssueInner = defineCredentialedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/fetch-issues-inner",
  provider: "linear",
  entries: {
    linear_get_issue: requireEntry(
      LINEAR_HUB_TOOLS.linear_get_issue,
      "linear_get_issue",
    ),
  },
});

async function fetchAllOrFail(
  callId: string,
  toolName: string,
  items: Record<string, unknown>[],
  runOne: (item: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
  const results: unknown[] = [];
  for (const item of items) {
    const result = await runOne(item);
    if (result.isError === true) {
      return {
        callId,
        isError: true,
        content:
          typeof result.content === "string"
            ? result.content
            : `${toolName}: item fetch failed: ${JSON.stringify(result.content)}`,
      };
    }
    results.push(result.content);
  }
  return { callId, content: { results } };
}

function createFetchArtifactsTool(env: BaseEnv): AgentTool {
  // `artifactReadInner(env)` is constructed PER CALL, inside the handler, so
  // it is rebuilt on every dispatch rather than cached across calls — cheap
  // (a hub-RPC context capture), and keeps this wrapper symmetric with the
  // credentialed wrappers below, whose lazy-construction requirement is load
  // bearing (see `createFetchNotesTool`).
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_FETCH_ARTIFACTS_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      const items = coerceItems(args, "artifactItems");
      const inner = artifactReadInner(env);
      return fetchAllOrFail(
        call.id,
        MULTI_SOURCE_COLLATERAL_FETCH_ARTIFACTS_DEFINITION.name,
        items,
        (item) =>
          inner.run(
            {
              id: call.id,
              name: "artifact_read",
              arguments: {
                artifactId: requireStringField(
                  item,
                  "artifactId",
                  MULTI_SOURCE_COLLATERAL_FETCH_ARTIFACTS_DEFINITION.name,
                ),
              },
            },
            signal,
          ),
      );
    },
  };
}

function createFetchNotesTool(env: BaseEnv): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_FETCH_NOTES_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      const items = coerceItems(args, "noteItems");
      // Constructed here, not at factory-build time: `defineCredentialedToolPackage`'s
      // factory throws `ToolCredentialMissingError` the instant it is invoked
      // with no `granola` credential in env. This step is fatal by design
      // (unlike gamma-presentation-creator's tolerant fetch), so a missing
      // credential should surface as the SAME loud tool failure a real
      // `granola_get_note` 401 would — not a distinct "wrapper never built"
      // failure mode — hence one construction per call, inside the try path
      // this function's caller already handles.
      const inner = granolaGetNoteInner(env);
      return fetchAllOrFail(
        call.id,
        MULTI_SOURCE_COLLATERAL_FETCH_NOTES_DEFINITION.name,
        items,
        (item) =>
          inner.run(
            {
              id: call.id,
              name: "granola_get_note",
              arguments: {
                noteId: requireStringField(
                  item,
                  "noteId",
                  MULTI_SOURCE_COLLATERAL_FETCH_NOTES_DEFINITION.name,
                ),
              },
            },
            signal,
          ),
      );
    },
  };
}

function createFetchIssuesTool(env: BaseEnv): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_FETCH_ISSUES_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      const items = coerceItems(args, "issueItems");
      const inner = linearGetIssueInner(env);
      return fetchAllOrFail(
        call.id,
        MULTI_SOURCE_COLLATERAL_FETCH_ISSUES_DEFINITION.name,
        items,
        (item) =>
          inner.run(
            {
              id: call.id,
              name: "linear_get_issue",
              arguments: {
                id: requireStringField(
                  item,
                  "id",
                  MULTI_SOURCE_COLLATERAL_FETCH_ISSUES_DEFINITION.name,
                ),
              },
            },
            signal,
          ),
      );
    },
  };
}

export function createMultiSourceCollateralFetchTools(
  env: BaseEnv,
): AgentTool[] {
  return [
    createFetchArtifactsTool(env),
    createFetchNotesTool(env),
    createFetchIssuesTool(env),
  ];
}

/** Env keys these wrapper tools need injected — the same keys the wrapped
 * packages themselves declare. Re-exported so `interchange-tools.ts`'s
 * `defineTool({ requires })` stays a single source of truth with this file. */
export const FETCH_TOOLS_REQUIRES = [
  ...artifactReadInner.requires,
  ...granolaGetNoteInner.requires,
  ...linearGetIssueInner.requires,
];
