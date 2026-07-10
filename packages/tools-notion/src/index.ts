import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type NotionFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type NotionToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  notionVersion?: string;
  fetcher?: NotionFetch;
};

const DEFAULT_BASE_URL = "https://api.notion.com";
// Notion requires an explicit API version header on every request; pinning it
// keeps response shapes stable regardless of the workspace's default version.
const DEFAULT_NOTION_VERSION = "2022-06-28";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function notionHeaders(config: NotionToolsConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Notion-Version": config.notionVersion ?? DEFAULT_NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalPageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(value, MAX_PAGE_SIZE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(config: NotionToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Notion apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Notion baseUrl must be a valid URL");
    }
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

function notionUrl(config: NotionToolsConfig, path: string): URL {
  return new URL(
    `${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}${path}`,
  );
}

async function fetchNotionJSON(
  config: NotionToolsConfig,
  url: URL,
  init: { method: "GET" | "POST"; body?: unknown },
  signal: AbortSignal,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const requestInit: RequestInit = {
    method: init.method,
    headers: notionHeaders(config),
    signal,
  };
  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }

  const response = await fetcher(url.toString(), requestInit);

  if (!response.ok) {
    const bodyText = errorMessageFromBody(
      await response.text().catch(() => ""),
    );
    const detail = response.statusText || bodyText;
    throw new Error(`Notion API error: ${response.status} ${detail ?? ""}`);
  }

  const data: unknown = await response.json();
  return data;
}

async function search(
  config: NotionToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    page_size: optionalPageSize(args.pageSize),
  };
  const query = optionalString(args.query);
  if (query !== null) {
    body.query = query;
  }
  const filterType = optionalString(args.filterType);
  if (filterType !== null) {
    if (filterType !== "page" && filterType !== "database") {
      throw new Error('filterType must be "page" or "database"');
    }
    body.filter = { property: "object", value: filterType };
  }
  const startCursor = optionalString(args.startCursor);
  if (startCursor !== null) {
    body.start_cursor = startCursor;
  }

  const url = notionUrl(config, "/v1/search");
  return fetchNotionJSON(config, url, { method: "POST", body }, signal);
}

async function getPage(
  config: NotionToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const pageId = optionalString(args.pageId);
  if (pageId === null) {
    throw new Error("pageId is required");
  }
  const url = notionUrl(config, `/v1/pages/${encodeURIComponent(pageId)}`);
  return fetchNotionJSON(config, url, { method: "GET" }, signal);
}

async function getPageContent(
  config: NotionToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const blockId = optionalString(args.blockId);
  if (blockId === null) {
    throw new Error("blockId is required");
  }
  const url = notionUrl(
    config,
    `/v1/blocks/${encodeURIComponent(blockId)}/children`,
  );
  url.searchParams.set("page_size", String(optionalPageSize(args.pageSize)));
  const startCursor = optionalString(args.startCursor);
  if (startCursor !== null) {
    url.searchParams.set("start_cursor", startCursor);
  }
  return fetchNotionJSON(config, url, { method: "GET" }, signal);
}

async function getDatabase(
  config: NotionToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const databaseId = optionalString(args.databaseId);
  if (databaseId === null) {
    throw new Error("databaseId is required");
  }
  const url = notionUrl(
    config,
    `/v1/databases/${encodeURIComponent(databaseId)}`,
  );
  return fetchNotionJSON(config, url, { method: "GET" }, signal);
}

async function queryDatabase(
  config: NotionToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const databaseId = optionalString(args.databaseId);
  if (databaseId === null) {
    throw new Error("databaseId is required");
  }
  const body: Record<string, unknown> = {
    page_size: optionalPageSize(args.pageSize),
  };
  if (isRecord(args.filter)) {
    body.filter = args.filter;
  }
  if (Array.isArray(args.sorts)) {
    body.sorts = args.sorts;
  }
  const startCursor = optionalString(args.startCursor);
  if (startCursor !== null) {
    body.start_cursor = startCursor;
  }

  const url = notionUrl(
    config,
    `/v1/databases/${encodeURIComponent(databaseId)}/query`,
  );
  return fetchNotionJSON(config, url, { method: "POST", body }, signal);
}

// Notion page bodies are block trees. A plain string is by far the most common
// thing an agent wants to write, so accept `text` and build a single paragraph
// block for it; callers needing rich structure can pass raw `children` blocks
// (passed through as-is) instead.
function buildPageChildren(
  args: Record<string, unknown>,
): unknown[] | undefined {
  if (Array.isArray(args.children)) {
    return args.children;
  }
  const text = optionalString(args.text);
  if (text === null) {
    return undefined;
  }
  return [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: text } }],
      },
    },
  ];
}

async function createPage(
  config: NotionToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const parentPageId = optionalString(args.parentPageId);
  const parentDatabaseId = optionalString(args.parentDatabaseId);
  if (parentPageId === null && parentDatabaseId === null) {
    throw new Error("parentPageId or parentDatabaseId is required");
  }
  if (parentPageId !== null && parentDatabaseId !== null) {
    throw new Error("pass only one of parentPageId or parentDatabaseId");
  }

  const body: Record<string, unknown> = {};
  if (parentPageId !== null) {
    body.parent = { page_id: parentPageId };
  } else {
    body.parent = { database_id: parentDatabaseId };
  }

  if (isRecord(args.properties)) {
    body.properties = args.properties;
  } else {
    const title = optionalString(args.title);
    if (title === null) {
      throw new Error("title or properties is required");
    }
    // A page parented under another page only accepts a `title` property; a
    // database page's title property may be named differently, so callers
    // targeting a database should pass `properties` explicitly.
    body.properties = {
      title: { title: [{ type: "text", text: { content: title } }] },
    };
  }

  const children = buildPageChildren(args);
  if (children !== undefined) {
    body.children = children;
  }

  const url = notionUrl(config, "/v1/pages");
  return fetchNotionJSON(config, url, { method: "POST", body }, signal);
}

const SEARCH_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description:
        "Text matched against page and database titles. Omit to list everything the integration can access (most-recently edited first).",
    },
    filterType: {
      type: "string",
      description:
        'Restrict results to one object type: "page" or "database". Omit to return both.',
    },
    pageSize: {
      type: "number",
      description: "Maximum number of results to return (1-100, default 25).",
    },
    startCursor: {
      type: "string",
      description:
        "Pagination cursor from a previous response's `next_cursor` to fetch the next page.",
    },
  },
};

const GET_PAGE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    pageId: {
      type: "string",
      description: "The id of the page to fetch.",
    },
  },
  required: ["pageId"],
};

const GET_PAGE_CONTENT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    blockId: {
      type: "string",
      description:
        "The id of the page (or a block within it) whose child blocks to fetch. A page id returns the page's top-level content blocks.",
    },
    pageSize: {
      type: "number",
      description: "Maximum number of blocks to return (1-100, default 25).",
    },
    startCursor: {
      type: "string",
      description:
        "Pagination cursor from a previous response's `next_cursor` to fetch the next page of blocks.",
    },
  },
  required: ["blockId"],
};

const GET_DATABASE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    databaseId: {
      type: "string",
      description: "The id of the database to fetch (returns its schema).",
    },
  },
  required: ["databaseId"],
};

const QUERY_DATABASE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    databaseId: {
      type: "string",
      description: "The id of the database to query.",
    },
    filter: {
      type: "object",
      description:
        "Notion database filter object, passed through as-is. See the Notion API filter reference; keys are property names mapped to condition objects.",
    },
    sorts: {
      type: "array",
      description:
        'Notion sorts array, passed through as-is. Example: [{"property":"Name","direction":"ascending"}].',
    },
    pageSize: {
      type: "number",
      description: "Maximum number of rows to return (1-100, default 25).",
    },
    startCursor: {
      type: "string",
      description:
        "Pagination cursor from a previous response's `next_cursor` to fetch the next page.",
    },
  },
  required: ["databaseId"],
};

const CREATE_PAGE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    parentPageId: {
      type: "string",
      description:
        "Create the new page as a child of this page. Provide exactly one of parentPageId or parentDatabaseId.",
    },
    parentDatabaseId: {
      type: "string",
      description:
        "Create the new page as a row in this database. Provide exactly one of parentPageId or parentDatabaseId. When targeting a database, pass `properties` matching the database schema.",
    },
    title: {
      type: "string",
      description:
        "Page title. Used to build a `title` property automatically for a page parented under another page. Ignored when `properties` is provided.",
    },
    properties: {
      type: "object",
      description:
        "Notion page properties object, passed through as-is. Required when creating a row in a database (keys must match the database schema).",
    },
    text: {
      type: "string",
      description:
        "Optional body text, added as a single paragraph block. Ignored when `children` is provided.",
    },
    children: {
      type: "array",
      description:
        "Optional array of Notion block objects for the page body, passed through as-is. Takes precedence over `text`.",
    },
  },
};

export const NOTION_SEARCH_DEFINITION: ToolDefinition = {
  name: "notion_search",
  description:
    "Search the Notion workspace for pages and databases by title text. Use `filterType` to restrict to pages or databases, or omit `query` to list accessible content. Only content shared with the integration is returned. Read-only.",
  inputSchema: SEARCH_INPUT_SCHEMA,
};

export const NOTION_GET_PAGE_DEFINITION: ToolDefinition = {
  name: "notion_get_page",
  description:
    "Fetch a single Notion page's metadata and properties by id. Use notion_get_page_content to read the page body. Read-only.",
  inputSchema: GET_PAGE_INPUT_SCHEMA,
};

export const NOTION_GET_PAGE_CONTENT_DEFINITION: ToolDefinition = {
  name: "notion_get_page_content",
  description:
    "Fetch the child blocks (the body content) of a Notion page or block by id. Returns a paginated list of block objects; follow `next_cursor` for more. Read-only.",
  inputSchema: GET_PAGE_CONTENT_INPUT_SCHEMA,
};

export const NOTION_GET_DATABASE_DEFINITION: ToolDefinition = {
  name: "notion_get_database",
  description:
    "Fetch a Notion database's schema (its properties/columns) by id. Read-only.",
  inputSchema: GET_DATABASE_INPUT_SCHEMA,
};

export const NOTION_QUERY_DATABASE_DEFINITION: ToolDefinition = {
  name: "notion_query_database",
  description:
    "Query the rows (pages) of a Notion database by id, with optional `filter` and `sorts` passed through to the Notion API. Supports pagination via `startCursor`. Read-only.",
  inputSchema: QUERY_DATABASE_INPUT_SCHEMA,
};

export const NOTION_CREATE_PAGE_DEFINITION: ToolDefinition = {
  name: "notion_create_page",
  description:
    "Create a new Notion page — either as a child of a page (pass `parentPageId` + `title`) or as a row in a database (pass `parentDatabaseId` + `properties`). Optional body via `text` or `children`. WRITES to Notion: use only after explicit human approval.",
  inputSchema: CREATE_PAGE_INPUT_SCHEMA,
};

function buildSearchHandler(config: NotionToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await search(config, args, signal));
}

function buildGetPageHandler(config: NotionToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await getPage(config, args, signal));
}

function buildGetPageContentHandler(config: NotionToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await getPageContent(config, args, signal));
}

function buildGetDatabaseHandler(config: NotionToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await getDatabase(config, args, signal));
}

function buildQueryDatabaseHandler(config: NotionToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await queryDatabase(config, args, signal));
}

function buildCreatePageHandler(config: NotionToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await createPage(config, args, signal));
}

export function createNotionTools(config: NotionToolsConfig): AgentTool[] {
  validateConfig(config);

  return [
    {
      kind: "string",
      definition: NOTION_SEARCH_DEFINITION,
      handler: buildSearchHandler(config),
    },
    {
      kind: "string",
      definition: NOTION_GET_PAGE_DEFINITION,
      handler: buildGetPageHandler(config),
    },
    {
      kind: "string",
      definition: NOTION_GET_PAGE_CONTENT_DEFINITION,
      handler: buildGetPageContentHandler(config),
    },
    {
      kind: "string",
      definition: NOTION_GET_DATABASE_DEFINITION,
      handler: buildGetDatabaseHandler(config),
    },
    {
      kind: "string",
      definition: NOTION_QUERY_DATABASE_DEFINITION,
      handler: buildQueryDatabaseHandler(config),
    },
    {
      kind: "string",
      definition: NOTION_CREATE_PAGE_DEFINITION,
      handler: buildCreatePageHandler(config),
    },
  ];
}

function handlerForDefinition(config: NotionToolsConfig, name: string) {
  switch (name) {
    case NOTION_SEARCH_DEFINITION.name:
      return buildSearchHandler(config);
    case NOTION_GET_PAGE_DEFINITION.name:
      return buildGetPageHandler(config);
    case NOTION_GET_PAGE_CONTENT_DEFINITION.name:
      return buildGetPageContentHandler(config);
    case NOTION_GET_DATABASE_DEFINITION.name:
      return buildGetDatabaseHandler(config);
    case NOTION_QUERY_DATABASE_DEFINITION.name:
      return buildQueryDatabaseHandler(config);
    case NOTION_CREATE_PAGE_DEFINITION.name:
      return buildCreatePageHandler(config);
    default:
      throw new Error(`Unknown notion tool: ${name}`);
  }
}

function createNotionToolFor(
  config: NotionToolsConfig,
  definition: ToolDefinition,
): AgentTool[] {
  validateConfig(config);
  return [
    {
      kind: "string",
      definition,
      handler: handlerForDefinition(config, definition.name),
    },
  ];
}

function resolveBaseUrl(config: {
  apiKey: string;
  baseURL: string;
}): NotionToolsConfig {
  const base: NotionToolsConfig = { apiKey: config.apiKey };
  if (config.baseURL.length > 0) {
    base.baseUrl = config.baseURL;
  }
  return base;
}

/**
 * Hub tool registry entries for notion. Each entry declares the tool definition,
 * the Interchange provider name for credential resolution, and a factory that
 * returns the AgentTool handlers given resolved credentials.
 *
 * Import and spread into the hub's KNOWN_TOOLS to register. No hub logic changes
 * are needed when new entries are added here.
 */
export const NOTION_HUB_TOOLS = {
  notion_search: {
    definition: NOTION_SEARCH_DEFINITION,
    providerName: "notion" as const,
    sideEffect: "read" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createNotionToolFor(resolveBaseUrl(config), NOTION_SEARCH_DEFINITION),
  },
  notion_get_page: {
    definition: NOTION_GET_PAGE_DEFINITION,
    providerName: "notion" as const,
    sideEffect: "read" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createNotionToolFor(resolveBaseUrl(config), NOTION_GET_PAGE_DEFINITION),
  },
  notion_get_page_content: {
    definition: NOTION_GET_PAGE_CONTENT_DEFINITION,
    providerName: "notion" as const,
    sideEffect: "read" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createNotionToolFor(
        resolveBaseUrl(config),
        NOTION_GET_PAGE_CONTENT_DEFINITION,
      ),
  },
  notion_get_database: {
    definition: NOTION_GET_DATABASE_DEFINITION,
    providerName: "notion" as const,
    sideEffect: "read" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createNotionToolFor(
        resolveBaseUrl(config),
        NOTION_GET_DATABASE_DEFINITION,
      ),
  },
  notion_query_database: {
    definition: NOTION_QUERY_DATABASE_DEFINITION,
    providerName: "notion" as const,
    sideEffect: "read" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createNotionToolFor(
        resolveBaseUrl(config),
        NOTION_QUERY_DATABASE_DEFINITION,
      ),
  },
  notion_create_page: {
    definition: NOTION_CREATE_PAGE_DEFINITION,
    providerName: "notion" as const,
    sideEffect: "write" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createNotionToolFor(
        resolveBaseUrl(config),
        NOTION_CREATE_PAGE_DEFINITION,
      ),
  },
};
