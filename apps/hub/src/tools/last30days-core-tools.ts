// Hub-proxy registry entries for the stateless last30days core tools.
//
// The tool implementations live in @workbench/tools-last30days (a native
// tool package). This file adapts them into the ContextToolEntry shape the
// KNOWN_TOOLS proxy expects so they keep working during the proxy
// coexistence window; the proxy and these entries are removed in M3.8.

import {
  LAST30DAYS_COLLECT_DEFINITION,
  LAST30DAYS_CORE_EXTRACT_DEFINITION,
  LAST30DAYS_CORE_REPORT_DEFINITION,
  LAST30DAYS_ENTITY_QUERIES_DEFINITION,
  LAST30DAYS_GROUND_QUERIES_DEFINITION,
  HEARTBEAT_FORMAT_BRIEF_MAIL_REFS_DEFINITION,
  HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION,
  HEARTBEAT_MERGE_BRIEF_SOURCES_DEFINITION,
  LAST30DAYS_VALIDATE_DEFINITION,
  LAST30DAYS_WORKFLOW_BRIEF_DEFINITION,
  createLast30daysTools,
} from "@workbench/tools-last30days";
import type { ContextToolEntry } from "../lib/tool-registry";

function toolByName(name: string) {
  return () => {
    const tool = createLast30daysTools().find(
      (t) => t.definition.name === name,
    );
    if (tool === undefined)
      throw new Error(`last30days tool not found: ${name}`);
    return [tool];
  };
}

export const LAST30DAYS_CORE_HUB_TOOLS: Record<string, ContextToolEntry> = {
  last30days_core_extract: {
    sideEffect: "read",
    definition: LAST30DAYS_CORE_EXTRACT_DEFINITION,
    createTools: toolByName("last30days_core_extract"),
  },
  last30days_core_report: {
    sideEffect: "read",
    definition: LAST30DAYS_CORE_REPORT_DEFINITION,
    createTools: toolByName("last30days_core_report"),
  },
  last30days_validate: {
    sideEffect: "read",
    definition: LAST30DAYS_VALIDATE_DEFINITION,
    createTools: toolByName("last30days_validate"),
  },
  last30days_workflow_brief: {
    sideEffect: "read",
    definition: LAST30DAYS_WORKFLOW_BRIEF_DEFINITION,
    createTools: toolByName("last30days_workflow_brief"),
  },
  last30days_ground_queries: {
    sideEffect: "read",
    definition: LAST30DAYS_GROUND_QUERIES_DEFINITION,
    createTools: toolByName("last30days_ground_queries"),
  },
  last30days_collect: {
    sideEffect: "read",
    definition: LAST30DAYS_COLLECT_DEFINITION,
    createTools: toolByName("last30days_collect"),
  },
  last30days_entity_queries: {
    sideEffect: "read",
    definition: LAST30DAYS_ENTITY_QUERIES_DEFINITION,
    createTools: toolByName("last30days_entity_queries"),
  },
  heartbeat_merge_brief_sources: {
    sideEffect: "read",
    definition: HEARTBEAT_MERGE_BRIEF_SOURCES_DEFINITION,
    createTools: toolByName("heartbeat_merge_brief_sources"),
  },
  heartbeat_format_brief_title: {
    sideEffect: "read",
    definition: HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION,
    createTools: toolByName("heartbeat_format_brief_title"),
  },
  heartbeat_format_brief_mail_refs: {
    sideEffect: "read",
    definition: HEARTBEAT_FORMAT_BRIEF_MAIL_REFS_DEFINITION,
    createTools: toolByName("heartbeat_format_brief_mail_refs"),
  },
};
