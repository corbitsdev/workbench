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
  parseArgs,
  type LinearToolsConfig,
} from "./shared";

const LIST_WEBHOOKS_QUERY = `query ListWebhooks($first: Int!, $after: String) {
  webhooks(first: $first, after: $after) {
    nodes { id url enabled label }
    pageInfo { endCursor hasNextPage }
  }
}`;

const WEBHOOK_CREATE = `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) {
    success
    webhook { id url enabled }
  }
}`;

const WEBHOOK_UPDATE = `mutation WebhookUpdate($id: String!, $input: WebhookUpdateInput!) {
  webhookUpdate(id: $id, input: $input) {
    success
    webhook { id url enabled }
  }
}`;

const WEBHOOK_DELETE = `mutation WebhookDelete($id: String!) {
  webhookDelete(id: $id) {
    success
  }
}`;

const ListWebhooksArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

const SaveWebhookArgsSchema = type({
  "id?": "string",
  url: "string > 0",
  "label?": "string",
  "enabled?": "boolean",
  "teamId?": "string",
});

const DeleteWebhookArgsSchema = type({ id: "string > 0" });

export async function listWebhooks(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListWebhooksArgsSchema, rawArgs, "linear_list_webhooks");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    LIST_WEBHOOKS_QUERY,
    paginationVariables(pagination),
    signal,
  );
  return connectionResult(data.webhooks);
}

export async function saveWebhook(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SaveWebhookArgsSchema, rawArgs, "linear_save_webhook");
  const input: Record<string, unknown> = { url: args.url };
  if (args.label !== undefined) input.label = args.label;
  if (args.enabled !== undefined) input.enabled = args.enabled;
  if (args.teamId !== undefined) input.teamId = args.teamId;
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      WEBHOOK_UPDATE,
      { id: args.id, input },
      signal,
    );
    return data.webhookUpdate ?? { success: false };
  }
  const data = await fetchLinearGraphQL(
    config,
    WEBHOOK_CREATE,
    { input },
    signal,
  );
  return data.webhookCreate ?? { success: false };
}

export async function deleteWebhook(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(DeleteWebhookArgsSchema, rawArgs, "linear_delete_webhook");
  const data = await fetchLinearGraphQL(
    config,
    WEBHOOK_DELETE,
    { id: args.id },
    signal,
  );
  return data.webhookDelete ?? { success: false };
}

export const LINEAR_LIST_WEBHOOKS_DEFINITION: ToolDefinition = {
  name: "linear_list_webhooks",
  description: "List workspace webhooks (admin scope may be required).",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: [],
  },
};

export const LINEAR_SAVE_WEBHOOK_DEFINITION: ToolDefinition = {
  name: "linear_save_webhook",
  description: "Create or update a webhook (write).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      url: { type: "string" },
      label: { type: "string" },
      enabled: { type: "boolean" },
      teamId: { type: "string" },
    },
    required: ["url"],
  },
};

export const LINEAR_DELETE_WEBHOOK_DEFINITION: ToolDefinition = {
  name: "linear_delete_webhook",
  description: "Delete a webhook (write).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};