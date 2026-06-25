// Hub-proxy registry entries for the stateless last30days core tools.
//
// The tool implementations live in @workbench/tools-last30days (a native
// tool package). This file adapts them into the ContextToolEntry shape the
// KNOWN_TOOLS proxy expects so they keep working during the proxy
// coexistence window; the proxy and these entries are removed in M3.8.

import {
  LAST30DAYS_CORE_EXTRACT_DEFINITION,
  LAST30DAYS_CORE_REPORT_DEFINITION,
  LAST30DAYS_VALIDATE_DEFINITION,
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
    definition: LAST30DAYS_CORE_EXTRACT_DEFINITION,
    createTools: toolByName("last30days_core_extract"),
  },
  last30days_core_report: {
    definition: LAST30DAYS_CORE_REPORT_DEFINITION,
    createTools: toolByName("last30days_core_report"),
  },
  last30days_validate: {
    definition: LAST30DAYS_VALIDATE_DEFINITION,
    createTools: toolByName("last30days_validate"),
  },
};
