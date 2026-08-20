// What every route suite asserts about a written asset tree: it is the
// two-file source codebase `agentDefinitionSourceTree` renders, and the
// definition it carries round-trips back through the same reader the
// routes use.

import {
  AGENT_DEFINITION_ENTRY_PATH,
  parseAgentDefinitionEntry,
} from "../src/definition-asset";

/** The two files a definition's asset tree carries, in render order. */
export const SOURCE_TREE_PATHS = ["package.json", AGENT_DEFINITION_ENTRY_PATH];

/** The serialized definition a written source tree carries. */
export function definitionFrom(
  files: Record<string, string | Uint8Array> | undefined,
): string {
  const entry = files?.[AGENT_DEFINITION_ENTRY_PATH];
  if (typeof entry !== "string") {
    throw new Error("the written tree carries no entry module");
  }
  return parseAgentDefinitionEntry(new TextEncoder().encode(entry), "ast_1");
}
