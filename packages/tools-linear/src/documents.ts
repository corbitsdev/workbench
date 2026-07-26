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
  optionalString,
  parseArgs,
  requireMutationSuccess,
  type LinearToolsConfig,
} from "./shared";

const LIST_DOCUMENTS_QUERY = `query ListDocuments($first: Int!, $after: String, $filter: DocumentFilter) {
  documents(first: $first, after: $after, filter: $filter) {
    nodes { id title slug updatedAt }
    pageInfo { endCursor hasNextPage }
  }
}`;

const GET_DOCUMENT_QUERY = `query GetDocument($id: String!) {
  document(id: $id) {
    id title slug content updatedAt
  }
}`;

const DOCUMENT_CREATE = `mutation DocumentCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) {
    success
    document { id title slug }
  }
}`;

const DOCUMENT_UPDATE = `mutation DocumentUpdate($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) {
    success
    document { id title slug }
  }
}`;

const ListDocumentsArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
  "query?": "string",
  "project?": "string",
  "team?": "string",
});

const GetDocumentArgsSchema = type({ id: "string > 0" });

const SaveDocumentArgsSchema = type({
  "id?": "string",
  title: "string > 0",
  "content?": "string",
  "project?": "string",
  "team?": "string",
});

export async function listDocuments(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    ListDocumentsArgsSchema,
    rawArgs,
    "linear_list_documents",
  );
  const pagination = resolveListPagination(
    args,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const query = optionalString(args.query);
  const project = optionalString(args.project);
  const team = optionalString(args.team);
  const filter: Record<string, unknown> = {};
  if (query !== null) filter.title = { containsIgnoreCase: query };
  if (project !== null) filter.project = { id: { eq: project } };
  if (team !== null) filter.team = { id: { eq: team } };
  const data = await fetchLinearGraphQL(
    config,
    LIST_DOCUMENTS_QUERY,
    {
      ...paginationVariables(pagination),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    signal,
  );
  return connectionResult(data.documents);
}

export async function getDocument(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetDocumentArgsSchema, rawArgs, "linear_get_document");
  const data = await fetchLinearGraphQL(
    config,
    GET_DOCUMENT_QUERY,
    { id: args.id },
    signal,
  );
  if (data.document === null || data.document === undefined) {
    throw new Error(`Linear document not found: ${args.id}`);
  }
  return data.document;
}

export async function saveDocument(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    SaveDocumentArgsSchema,
    rawArgs,
    "linear_save_document",
  );
  const input: Record<string, unknown> = { title: args.title };
  if (args.content !== undefined) input.content = args.content;
  if (args.project !== undefined) input.projectId = args.project;
  if (args.team !== undefined) input.teamId = args.team;
  if (args.id !== undefined) {
    const data = await fetchLinearGraphQL(
      config,
      DOCUMENT_UPDATE,
      { id: args.id, input },
      signal,
    );
    return requireMutationSuccess(data, "documentUpdate");
  }
  const data = await fetchLinearGraphQL(
    config,
    DOCUMENT_CREATE,
    { input },
    signal,
  );
  return requireMutationSuccess(data, "documentCreate");
}

export const LINEAR_LIST_DOCUMENTS_DEFINITION: ToolDefinition = {
  name: "linear_list_documents",
  description: "List Linear documents.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      first: { type: "number" },
      cursor: { type: "string" },
      after: { type: "string" },
      query: { type: "string" },
      project: { type: "string" },
      team: { type: "string" },
    },
    required: [],
  },
};

export const LINEAR_GET_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "linear_get_document",
  description: "Get a document by id or slug.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

export const LINEAR_SAVE_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "linear_save_document",
  description: "Create or update a document (write).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
      project: { type: "string" },
      team: { type: "string" },
    },
    required: ["title"],
  },
};
