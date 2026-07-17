import type { ToolDefinition } from "@intx/types/runtime";

/**
 * `invoke_agent` definition (db-free — the executable handler lives in
 * `apps/hub/src/tools/invoke-agent.ts` because it resolves per-user instance
 * ownership and provisions against the hub-owned `member_agent_instance`
 * table, the same split `list_agents`/`search_agents` use).
 *
 * Delegates a brief to a specialist agent DEFINITION (found via
 * `search_agents`/`list_agents`): resolves or provisions a running instance
 * of it for the invoking member, then sends the brief. Provisioning
 * (instance, member attribution, tool grants) happens automatically — no
 * operator step required.
 */
export const INVOKE_AGENT_DEFINITION: ToolDefinition = {
  name: "invoke_agent",
  description:
    "Delegate a piece of work to a specialist agent — for parallelizing or when the work calls for a different agent's expertise (e.g. handing a deep-research task to a research specialist, or LinkedIn content to Lincoln). Find the target with search_agents or list_agents and pass its agentDefinitionId. Resolves or provisions a running instance of that agent for you automatically (instance, attribution, and tool grants — no setup needed) and sends it your brief. You stay the coordinator; the subagent does the work in its own session.",
  inputSchema: {
    type: "object",
    properties: {
      agentDefinitionId: {
        type: "string",
        description:
          "The agent definition id to invoke, from search_agents/list_agents (agentDefinitionId field).",
      },
      brief: {
        type: "string",
        description:
          "The task brief to hand off — what you need the subagent to do and any context it needs, since it starts with no memory of this conversation.",
      },
    },
    required: ["agentDefinitionId", "brief"],
  },
};
