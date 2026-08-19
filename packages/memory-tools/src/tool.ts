// The `@corbits/memory-tools` bundle: `memory_search`, `memory_add`, and
// `memory_list`, the agent-facing surface a workflow definition pins to
// reach the tenant's firm-memory plane. Calls `./client.ts` against the
// SAME `/api/tenants/:tenantId/memory/*` HTTP surface a browser caller
// reaches (`apps/hub/src/memory-mount.ts`, CL-6296), authenticating with
// the sidecar's own bearer token and the run's own mailbox address — both
// already reach a workflow-process child's tool env
// (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`), so this
// bundle needs no per-user credential and never touches a database
// handle.
//
// Identity is never a model-supplied argument: none of the three tools'
// input schemas below carry a tenant or principal field, and none of
// `./client.ts`'s request bodies do either — attribution comes entirely
// from the run's own authenticated address on the hub side
// (`createAccountCallerResolver`'s workflow branch), matching
// `@corbits/artifact-tools`' precedent. A transport, HTTP, or shape
// failure comes back as a completed `ToolResult` with `isError: true` —
// never fabricate a memory or a search result when a call fails. There is
// no "memory isn't set up" degraded state to special-case: config is
// env-only and always resolves to at least a lexical-only floor (CL-6289),
// so the memory plane is always mounted.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { addMemory, listMemory, searchMemory } from "./client";

export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_ADD_TOOL = "memory_add";
export const MEMORY_LIST_TOOL = "memory_list";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach credential. */
export interface WorkflowMemoryEnv extends BaseEnv {
  readonly hubMemoryUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowMemoryEnv) {
  return {
    hubMemoryUrl: env.hubMemoryUrl,
    sidecarToken: env.sidecarToken,
    runAddress: env.address,
  };
}

async function runMemorySearch(
  env: WorkflowMemoryEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const query = call.arguments["query"];
  if (typeof query !== "string" || query === "") {
    return errorResult(call.id, new Error("memory_search requires a query"));
  }
  const limitArg = call.arguments["limit"];
  const limit = typeof limitArg === "number" ? limitArg : undefined;
  try {
    const searchInput = limit !== undefined ? { query, limit } : { query };
    const items = await searchMemory(clientConfig(env), searchInput);
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({ items }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runMemoryAdd(
  env: WorkflowMemoryEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const title = call.arguments["title"];
  const text = call.arguments["text"];
  if (typeof title !== "string" || title === "") {
    return errorResult(call.id, new Error("memory_add requires a title"));
  }
  if (typeof text !== "string" || text === "") {
    return errorResult(call.id, new Error("memory_add requires text"));
  }
  const kindArg = call.arguments["kind"];
  const kind = typeof kindArg === "string" ? kindArg : undefined;
  try {
    const addInput =
      kind !== undefined ? { title, text, kind } : { title, text };
    const added = await addMemory(clientConfig(env), addInput);
    return { callId: call.id, isError: false, content: JSON.stringify(added) };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runMemoryList(
  env: WorkflowMemoryEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const limitArg = call.arguments["limit"];
  const limit = typeof limitArg === "number" ? limitArg : undefined;
  try {
    const entries = await listMemory(
      clientConfig(env),
      limit !== undefined ? { limit } : {},
    );
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({ entries }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/memory-tools` bundle factory: three tools, three env keys
 * — the sanctioned CL-5852 path, mirroring `@corbits/artifact-tools`'
 * one-bundle shape.
 */
export const memoryTools = defineTool<WorkflowMemoryEnv>({
  id: "@corbits/memory-tools/memory",
  requires: ["hubMemoryUrl", "sidecarToken", "address"],
  definitions: [
    { name: MEMORY_SEARCH_TOOL },
    { name: MEMORY_ADD_TOOL },
    { name: MEMORY_LIST_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: MEMORY_SEARCH_TOOL,
        description:
          "Searches the tenant's firm memory (facts, decisions, and " +
          "notes recorded over time) for entries relevant to a query. " +
          "Returns an error result naming the failure when the memory " +
          "plane is unreachable — never fabricate a search result when " +
          "this happens.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            limit: {
              type: "number",
              description: "Maximum number of results to return.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: MEMORY_ADD_TOOL,
        description:
          "Records one entry into the tenant's firm memory — a fact, " +
          "decision, or note worth recalling later. Attribution (who " +
          "and which tenant) comes from the run itself, never from " +
          "these arguments.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "A short title." },
            text: { type: "string", description: "The entry's full text." },
            kind: {
              type: "string",
              description: 'Optional entry kind (e.g. "decision", "fact").',
            },
          },
          required: ["title", "text"],
        },
      },
      {
        name: MEMORY_LIST_TOOL,
        description:
          "Lists the tenant's most recent firm-memory entries as a " +
          "timeline, most recent first.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of entries to return.",
            },
          },
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case MEMORY_SEARCH_TOOL:
          return runMemorySearch(env, call);
        case MEMORY_ADD_TOOL:
          return runMemoryAdd(env, call);
        case MEMORY_LIST_TOOL:
          return runMemoryList(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/memory-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
