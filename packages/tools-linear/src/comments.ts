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
  parseArgs,
  requireMutationSuccess,
  type LinearToolsConfig,
} from "./shared";

const LIST_COMMENTS_QUERY = `query ListComments($issueId: String!, $first: Int!, $after: String) {
  issue(id: $issueId) {
    comments(first: $first, after: $after) {
      nodes { id body createdAt updatedAt user { name } }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body }
  }
}`;

const COMMENT_UPDATE = `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment { id body }
  }
}`;

const ListCommentsArgsSchema = type({
  issueId: "string > 0",
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

const SaveCommentArgsSchema = type({
  "id?": "string",
  issueId: "string > 0",
  body: "string > 0",
});

export async function listComments(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(ListCommentsArgsSchema, rawArgs, "linear_list_comments");
  const pagination = resolveListPagination(args, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const data = await fetchLinearGraphQL(
    config,
    LIST_COMMENTS_QUERY,
    { issueId: args.issueId, ...paginationVariables(pagination) },
    signal,
  );
  if (!isRecord(data.issue)) {
    throw new Error(`Linear issue not found: ${args.issueId}`);
  }
  return connectionResult(data.issue.comments);
}

export async function saveComment(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(SaveCommentArgsSchema, rawArgs, "linear_save_comment");
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      COMMENT_UPDATE,
      { id: args.id, input: { body: args.body } },
      signal,
    );
    return requireMutationSuccess(data, "commentUpdate");
  }
  const data = await fetchLinearGraphQL(
    config,
    COMMENT_CREATE,
    { input: { issueId: args.issueId, body: args.body } },
    signal,
  );
  return requireMutationSuccess(data, "commentCreate");
}

export const LINEAR_LIST_COMMENTS_DEFINITION: ToolDefinition = {
  name: "linear_list_comments",
  description: "List comments on a Linear issue.",
  inputSchema: {
    type: "object",
    properties: {
      issueId: { type: "string" },
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
    },
    required: ["issueId"],
  },
};

export const LINEAR_SAVE_COMMENT_DEFINITION: ToolDefinition = {
  name: "linear_save_comment",
  description:
    "Create or update a comment on an issue (write). Omit id to create; pass id to update.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Comment id to update." },
      issueId: { type: "string" },
      body: { type: "string", description: "Markdown body." },
    },
    required: ["issueId", "body"],
  },
};