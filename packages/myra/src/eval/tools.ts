/**
 * Synthetic, production-shaped tool definitions for Myra evals.
 * Names and descriptions mirror the real platform surface so a model
 * under test sees realistic choices — but every result is fixture data.
 *
 * Kept as a local shape (not `@intx/types` ToolDefinition) so the eval
 * package stays free of agent-runtime coupling; the runner only needs
 * name + description + a JSON-schema-ish input shape for advertising.
 */

export type EvalToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export const EVAL_PLATFORM_TOOLS: EvalToolDefinition[] = [
  {
    name: "search_tools",
    description:
      "Search the tool catalog by keyword. Returns matching package and tool names.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "load_tools",
    description:
      "Load tools from a catalog package into the current turn's advertised set.",
    inputSchema: {
      type: "object",
      properties: { package: { type: "string" } },
      required: ["package"],
    },
  },
  {
    name: "search_skills",
    description: "Search skills by keyword.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "load_skill",
    description: "Load a skill body by id so it can be followed this turn.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "memory_load",
    description: "Load durable memory entries for this operator.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
  {
    name: "memory_save",
    description: "Save a durable memory entry.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "workflow_list_kinds",
    description: "List workflow kinds available in this workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "workflow_start",
    description: "Start a workflow run of the given kind.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        input: { type: "object" },
      },
      required: ["kind"],
    },
  },
  {
    name: "artifact_create",
    description: "Create a durable artifact the operator can open later.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "mail_send",
    description:
      "Send a note to a teammate agent. Requires human approval before delivery.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the public web. Catalog-managed — load via search_tools first in production; available here for cases that advertise it.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

export function evalToolsByName(
  names: readonly string[],
): EvalToolDefinition[] {
  const byName = new Map(EVAL_PLATFORM_TOOLS.map((t) => [t.name, t]));
  const out: EvalToolDefinition[] = [];
  for (const name of names) {
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new Error(
        `evalToolsByName: unknown synthetic tool "${name}" — add it to EVAL_PLATFORM_TOOLS`,
      );
    }
    out.push(tool);
  }
  return out;
}

export const DEFAULT_EVAL_ADVERTISED_TOOL_NAMES: string[] =
  EVAL_PLATFORM_TOOLS.filter((t) => t.name !== "web_search").map(
    (t) => t.name,
  );
