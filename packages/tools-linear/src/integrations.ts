import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";
import { fetchLinearGraphQL } from "./client";
import { connectionResult } from "./pagination";
import { parseArgs, type LinearToolsConfig } from "./shared";

const LIST_INTEGRATIONS_QUERY = `query ListIntegrations {
  integrations {
    nodes {
      id
      service
      type
      createdAt
      updatedAt
    }
  }
}`;

const ListIntegrationsArgsSchema = type({});

export async function listIntegrations(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  parseArgs(ListIntegrationsArgsSchema, rawArgs, "linear_list_integrations");
  const data = await fetchLinearGraphQL(
    config,
    LIST_INTEGRATIONS_QUERY,
    {},
    signal,
  );
  return connectionResult(data.integrations);
}

export const LINEAR_LIST_INTEGRATIONS_DEFINITION: ToolDefinition = {
  name: "linear_list_integrations",
  description:
    "List workspace integrations (read-only). Does not configure OAuth or create webhooks.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};
