import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";
export { SEARCH_AGENTS_DEFINITION } from "@workbench/tools-agents";
import {
  SEARCH_AGENTS_DEFINITION,
  parseListLimit,
  parsePrincipalIds,
} from "@workbench/tools-agents";
import { eq, inArray } from "./sql-predicates";
import { resolveOwnedInstanceIds } from "./list-agents";
import type { ContextToolEntry } from "../lib/tool-registry";

export type SearchAgentsContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
};

function parseQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("query must be a non-empty string");
  }
  return value.trim();
}

type CandidateAgent = {
  instanceId: string;
  name: string;
  description: string | null;
  address: string;
  status: string;
  agentDefinitionId: string;
};

/**
 * Deterministic keyword score over name + description: a name match ranks
 * above a description-only match, and terms are split on whitespace so a
 * multi-word query only needs a substring hit per term.
 */
function scoreAgent(agent: CandidateAgent, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const name = agent.name.toLowerCase();
  const description = (agent.description ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export function createSearchAgentsTool(
  context: SearchAgentsContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: SEARCH_AGENTS_DEFINITION,
      handler: async (args) => {
        const query = parseQuery(args.query);
        const memberPrincipals = parsePrincipalIds(args.principals);
        const limit = parseListLimit(args.limit);

        const instanceIds = await resolveOwnedInstanceIds(
          context.db,
          context,
          memberPrincipals,
        );

        // Fail closed: an unresolved owner (null) or an owner with no
        // instances ([]) returns no matches, never a tenant-wide search.
        if (instanceIds === null || instanceIds.length === 0) {
          return JSON.stringify({ agents: [] }, null, 2);
        }

        const rows: CandidateAgent[] = await context.db
          .select({
            instanceId: intxSchema.agentInstance.id,
            name: intxSchema.agent.name,
            description: intxSchema.agent.description,
            address: intxSchema.agentInstance.address,
            status: intxSchema.agentInstance.status,
            agentDefinitionId: intxSchema.agentInstance.agentId,
          })
          .from(intxSchema.agentInstance)
          .innerJoin(
            intxSchema.agent,
            eq(intxSchema.agentInstance.agentId, intxSchema.agent.id),
          )
          .where(inArray(intxSchema.agentInstance.id, instanceIds));

        const ranked = rows
          .map((agent) => ({ agent, score: scoreAgent(agent, query) }))
          .filter(({ score }) => score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.agent.name.localeCompare(b.agent.name) ||
              a.agent.instanceId.localeCompare(b.agent.instanceId),
          )
          .slice(0, limit)
          .map(({ agent }) => agent);

        return JSON.stringify({ agents: ranked }, null, 2);
      },
    },
  ];
}

export const SEARCH_AGENTS_HUB_TOOLS: Record<string, ContextToolEntry> = {
  search_agents: {
    sideEffect: "read",
    definition: SEARCH_AGENTS_DEFINITION,
    createTools: (context) =>
      createSearchAgentsTool({
        db: context.db,
        tenantId: context.tenantId,
        principalId: context.principalId,
      }),
  },
};
