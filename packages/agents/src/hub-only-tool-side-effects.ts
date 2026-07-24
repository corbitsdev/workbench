import type { ToolSideEffect } from "@workbench/tool-manifest";

/**
 * Side effects for hub-backed tools with no `@workbench/tools-*` manifest row.
 * `known-tools-manifest-drift.test.ts` derives its hub-only name list from this map.
 */
export const HUB_ONLY_TOOL_SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  task_create: "write",
  task_list: "read",
  task_update: "write",
  heartbeat_format_brief_title: "read",
  heartbeat_format_brief_document: "read",
  heartbeat_format_brief_notify: "read",
  competitor_analysis_format_report_document: "read",
  sumble_account_intel_format_report_document: "read",
  granola_create_tasks: "write",
  granola_fanout_call: "write",
};
