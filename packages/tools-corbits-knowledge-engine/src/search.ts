import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  knowledgeEngineFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type KnowledgeEngineToolsConfig,
  type ResolvedKnowledgeEngineConfig,
} from "./shared";

const DEFAULT_K = 10;
const MAX_K = 50;

export const SearchArgsSchema = type({
  query: "string > 0",
  "k?": "number",
});

export type SearchArgs = typeof SearchArgsSchema.infer;

const SearchHitSchema = type({
  document_id: "string",
  title: "string",
  snippet: "string",
  score: "number",
});

const SearchResponseSchema = type({
  hits: SearchHitSchema.array(),
});

export type KnowledgeSearchHit = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
};

export type KnowledgeSearchResult = {
  hits: KnowledgeSearchHit[];
};

function normalizeK(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_K;
  }
  return Math.min(value, MAX_K);
}

async function search(
  config: ResolvedKnowledgeEngineConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<KnowledgeSearchResult> {
  const args = parseArgs(SearchArgsSchema, rawArgs, "search_company_knowledge");

  const body = {
    query: args.query,
    tenant_id: config.tenantId,
    principal_id: config.principalId ?? null,
    k: normalizeK(args.k),
  };

  const response = await knowledgeEngineFetchJSON(
    config,
    { path: "/api/search", body },
    signal,
  );

  const parsed = SearchResponseSchema(response);
  if (parsed instanceof type.errors) {
    throw new Error(
      `search_company_knowledge: invalid engine response: ${parsed.summary}`,
    );
  }

  return {
    hits: parsed.hits.map((hit) => ({
      documentId: hit.document_id,
      title: hit.title,
      snippet: hit.snippet,
      score: hit.score,
    })),
  };
}

export const SEARCH_COMPANY_KNOWLEDGE_DEFINITION: ToolDefinition = {
  name: "search_company_knowledge",
  description:
    "Search the team's shared knowledge base (call notes, docs, and other captured evidence) for passages relevant to a query. Returns ranked hits, each with a title, a snippet of the matching passage, a relevance score, and a documentId you can cite or use to fetch the source further.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query, in natural language.",
      },
      k: {
        type: "number",
        description:
          "Maximum number of hits to return. Defaults to 10, capped at 50.",
      },
    },
    required: ["query"],
  },
};

export const SEARCH_DEFINITIONS: ToolDefinition[] = [
  SEARCH_COMPANY_KNOWLEDGE_DEFINITION,
];

export function createSearchTools(
  config: KnowledgeEngineToolsConfig,
): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(SEARCH_COMPANY_KNOWLEDGE_DEFINITION, (args, signal) =>
      search(resolved, args, signal),
    ),
  ];
}
