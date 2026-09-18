// What every route suite asserts about a written asset tree: it is the
// two-file source codebase `agentDefinitionSourceTree` renders, and the
// definition it carries round-trips back through the same reader the
// routes use.

import {
  AGENT_DEFINITION_JSON_PATH,
  agentDefinitionSourceTree,
  parseAgentDefinitionJson,
} from "./definition-asset";
import {
  buildAgentDefinitionWorkflow,
  reindexPinnedSkills,
  serializeAgentDefinitionWorkflow,
} from "./agent-workflow";

/** The files a definition's asset tree carries, in render order. */
export const SOURCE_TREE_PATHS = ["package.json", "workflow.js", AGENT_DEFINITION_JSON_PATH];

/** The serialized definition a written source tree carries. */
export function definitionFrom(files: Record<string, string | Uint8Array> | undefined): string {
  const definitionJson = files?.[AGENT_DEFINITION_JSON_PATH];
  if (typeof definitionJson !== "string") {
    throw new Error("the written tree carries no definition projection");
  }
  return parseAgentDefinitionJson(new TextEncoder().encode(definitionJson), "ast_1");
}

/** A stored definition that already pins skills — the state every
 * pin-reading route observes. The stanza is the seed: no side table to
 * write, the bytes carry the pins like a real asset would. */
export function storedDefinitionBytesWithSkills(...names: string[]): Uint8Array {
  const tree = agentDefinitionSourceTree({
    handle: "research-buddy",
    workflowJson: reindexPinnedSkills(
      serializeAgentDefinitionWorkflow(
        buildAgentDefinitionWorkflow({
          handle: "research-buddy",
          tenantDomain: "acme.example",
          description: "",
          systemPrompt: "You are a careful research assistant.",
        }),
      ),
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
  });
  return new TextEncoder().encode(tree[AGENT_DEFINITION_JSON_PATH]);
}
