import type { ToolDefinition } from "@intx/types/runtime";

// Hub-backed granola workflow tools: the definition ships in this package's
// tarball (so workflow steps can call it over the hub-backed rail), while
// execution happens hub-side against hub-owned services — the same split
// `write_artifact` uses in @workbench/tools-artifact.

export const GRANOLA_SPAWN_CALL_RUNS_DEFINITION: ToolDefinition = {
  name: "granola_spawn_call_runs",
  description:
    "Fan out Granola call processing: parse a granola_list_notes result and start one process-granola-call run per note that has no call-notes artifact yet. Returns spawned run ids and skip counts. Idempotent — already-processed notes are skipped, so a quiet call spawns nothing.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The raw granola_list_notes result (JSON text: { notes: [...] }).",
      },
      limit: {
        type: "string",
        description:
          "Optional cap on how many notes to consider (a number as text). Defaults to 10. Named `limit` (not `maxCalls`) so the same trigger field name reaches both this tool and granola_list_notes's own `limit` argument with no per-workflow rename.",
      },
    },
    required: ["content"],
  },
};

export const GRANOLA_HUB_BACKED_DEFINITIONS: ToolDefinition[] = [
  GRANOLA_SPAWN_CALL_RUNS_DEFINITION,
];
