import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";
import { fetchLinearGraphQL } from "./client";
import {
  connectionResult,
  paginationVariables,
  resolveListPagination,
} from "./pagination";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  isRecord,
  optionalString,
  parseArgs,
  type LinearToolsConfig,
} from "./shared";
import { resolveTeamId } from "./teams";

function buildCycleFilter(
  cycleType: string | null,
): Record<string, unknown> | null {
  if (cycleType === "current") {
    return { isActive: { eq: true } };
  }
  if (cycleType === "previous") {
    return { isPast: { eq: true } };
  }
  if (cycleType === "next") {
    return { isFuture: { eq: true } };
  }
  return null;
}

const LIST_CYCLES_QUERY = `query ListCycles($teamId: String!, $first: Int!, $after: String, $filter: CycleFilter) {
  team(id: $teamId) {
    cycles(first: $first, after: $after, filter: $filter) {
      nodes { id name number startsAt endsAt }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const ListCyclesArgsSchema = type({
  team: "string > 0",
  "type?": "'current' | 'previous' | 'next'",
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

export async function listCycles(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListCyclesArgsSchema, rawArgs, "linear_list_cycles");
  const pagination = resolveListPagination(
    args,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const cycleType = optionalString(args.type);
  const filter = buildCycleFilter(cycleType);
  const resolvedTeamId = await resolveTeamId(config, args.team, signal);
  const data = await fetchLinearGraphQL(
    config,
    LIST_CYCLES_QUERY,
    {
      teamId: resolvedTeamId,
      ...paginationVariables(pagination),
      ...(filter !== null ? { filter } : {}),
    },
    signal,
  );
  if (!isRecord(data.team)) {
    throw new Error(`Linear team not found: ${args.team}`);
  }
  return connectionResult(data.team.cycles);
}

export const LINEAR_LIST_CYCLES_DEFINITION: ToolDefinition = {
  name: "linear_list_cycles",
  description: "List cycles for a team, optionally filtered by type.",
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string", description: "Team id or key." },
      type: { type: "string", description: "current, previous, or next." },
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: ["team"],
  },
};
