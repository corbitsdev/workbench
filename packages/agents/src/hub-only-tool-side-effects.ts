import type { ToolSideEffect } from "@workbench/tool-manifest";

/**
 * Side effects for hub-backed tools with no `@workbench/tools-*` manifest row.
 * `known-tools-manifest-drift.test.ts` derives its hub-only name list from this map.
 */
export const HUB_ONLY_TOOL_SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  task_create: "write",
  task_list: "read",
  task_update: "write",
  granola_create_tasks: "write",
  granola_fanout_call: "write",
};
