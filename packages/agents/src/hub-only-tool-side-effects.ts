import type { ToolSideEffect } from "@workbench/tool-manifest";

/**
 * Side effects for hub-backed tools with no `@workbench/tools-*` manifest row.
 * Keep in lockstep with `HUB_ONLY_TOOLS_NOT_IN_MANIFEST` in
 * `apps/hub/src/lib/known-tools-manifest-drift.test.ts`.
 */
export const HUB_ONLY_TOOL_SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  task_create: "write",
  task_list: "read",
  task_update: "write",
  heartbeat_format_brief_title: "read",
  heartbeat_format_brief_mail_refs: "read",
};
