// Scout as installable data: an id/handle/displayName/description/
// systemPrompt object plus the tool packages it needs — the same plain-
// data shape `@corbits/code-review`'s `ReviewerDefinition` establishes as
// "exactly what the agent-directory create path takes, so the same
// definition can be installed as an agent in a workbench." Scout adds one
// field that shape doesn't need: `toolPackagePins`, since Scout (unlike a
// pure-text reviewer) calls tools.
//
// Tools are never inlined here, matching every workflow definition in
// this catalog (see `workflows/attio-task-agent/src/index.ts`'s header
// comment): they arrive as pinned packages at deploy time, keeping this
// definition pure data. Two of the three pins are existing, already-wired
// workbench tool packages reused as-is — `@corbits/memory-tools`
// (knowledge-search/memory-add/memory-list) and `@corbits/web-search-tools`
// (web-research, Exa-backed, credential handle `"exa"`, satisfied by the
// keyless Exa MCP preset in `packages/connections/src/mcp-presets.ts`).
// The third, `@corbits/scout-agent` itself, supplies `./artifact-tool.ts`.
//
// `launch-diligence-brief` and `launch-fact-check` are not pinned here —
// see `./system-prompt.ts`'s header comment and this package's README for
// why they're deferred rather than wired to something that would fail.
import type { ToolPackagePin } from "@intx/types/tool-packages";
import { SCOUT_SYSTEM_PROMPT } from "./system-prompt";

export const SCOUT_AGENT_ID = "scout";
export const SCOUT_AGENT_HANDLE = "scout";
export const SCOUT_AGENT_DISPLAY_NAME = "Scout";
export const SCOUT_AGENT_DESCRIPTION =
  "Research and due-diligence analyst: searches firm memory and the web, " +
  "saves and recalls Library write-ups, and answers with sources.";

export const SCOUT_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/memory-tools", version: "0.0.4" },
  { name: "@corbits/web-search-tools", version: "0.0.3" },
  { name: "@corbits/scout-agent", version: "0.0.2" },
];

/** The plain-data shape the agent-directory create path takes. */
export interface ScoutAgentDefinition {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly toolPackagePins: readonly ToolPackagePin[];
}

export const SCOUT_AGENT_DEFINITION: ScoutAgentDefinition = {
  id: SCOUT_AGENT_ID,
  handle: SCOUT_AGENT_HANDLE,
  displayName: SCOUT_AGENT_DISPLAY_NAME,
  description: SCOUT_AGENT_DESCRIPTION,
  systemPrompt: SCOUT_SYSTEM_PROMPT,
  toolPackagePins: SCOUT_TOOL_PACKAGE_PINS,
};
