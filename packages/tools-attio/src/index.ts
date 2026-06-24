import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';

export type AttioFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AttioToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: AttioFetch;
};

const DEFAULT_BASE_URL = 'https://api.attio.com';
const DEFAULT_LIMIT = 25;
const DEFAULT_OFFSET = 0;
const MAX_LIMIT = 100;

function attioHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function optionalNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDataResponse(value: unknown): unknown {
  if (!isRecord(value) || !('data' in value)) {
    throw new Error('Attio response is missing the data field');
  }
  return value.data;
}

function validateConfig(config: AttioToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error('Attio apiKey is required');
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error('Attio baseUrl must be a valid URL');
    }
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

function attioUrl(config: AttioToolsConfig, path: string): URL {
  return new URL(`${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}${path}`);
}

async function fetchAttioJSON(
  config: AttioToolsConfig,
  url: URL,
  init: { method: 'GET' | 'POST'; body?: unknown },
  signal: AbortSignal
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const requestInit: RequestInit = {
    method: init.method,
    headers: attioHeaders(config.apiKey),
    signal,
  };
  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }

  const response = await fetcher(url.toString(), requestInit);

  if (!response.ok) {
    const bodyText = errorMessageFromBody(await response.text().catch(() => ''));
    const detail = response.statusText || bodyText;
    throw new Error(`Attio API error: ${response.status} ${detail ?? ''}`);
  }

  const data: unknown = await response.json();
  return data;
}

async function listObjects(config: AttioToolsConfig, signal: AbortSignal): Promise<unknown> {
  const url = attioUrl(config, '/v2/objects');
  return parseDataResponse(await fetchAttioJSON(config, url, { method: 'GET' }, signal));
}

async function queryRecords(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const object = optionalString(args.object);
  if (object === null) {
    throw new Error('object is required');
  }

  const limit = optionalPositiveInteger(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = optionalNonNegativeInteger(args.offset, DEFAULT_OFFSET);

  const url = attioUrl(config, `/v2/objects/${encodeURIComponent(object)}/records/query`);
  const body: Record<string, unknown> = { limit, offset };
  if (isRecord(args.filter)) {
    body.filter = args.filter;
  }
  if (Array.isArray(args.sorts)) {
    body.sorts = args.sorts;
  }
  return parseDataResponse(await fetchAttioJSON(config, url, { method: 'POST', body }, signal));
}

async function searchRecords(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const query = optionalString(args.query);
  if (query === null) {
    throw new Error('query is required');
  }

  const url = attioUrl(config, '/v2/records/search');
  const body = { query };
  return parseDataResponse(await fetchAttioJSON(config, url, { method: 'POST', body }, signal));
}

async function getRecord(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const object = optionalString(args.object);
  if (object === null) {
    throw new Error('object is required');
  }
  const recordId = optionalString(args.recordId);
  if (recordId === null) {
    throw new Error('recordId is required');
  }

  const url = attioUrl(
    config,
    `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`
  );
  return parseDataResponse(await fetchAttioJSON(config, url, { method: 'GET' }, signal));
}

async function listWorkspaceMembers(
  config: AttioToolsConfig,
  signal: AbortSignal
): Promise<unknown> {
  const url = attioUrl(config, '/v2/workspace-members');
  return parseDataResponse(await fetchAttioJSON(config, url, { method: 'GET' }, signal));
}

const QUERY_RECORDS_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    object: {
      type: 'string',
      description: 'The object slug to query, e.g. "companies" or "people".',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of records to return (1-100, default 25).',
    },
    offset: {
      type: 'number',
      description: 'Number of records to skip for pagination (default 0).',
    },
    filter: {
      type: 'object',
      description:
        'Server-side filter — pass this to LOOK UP specific records by name/domain/etc. rather than listing everything. This is the normal way to find a company or person: filter here instead of fetching a large page and scanning it yourself. Example: {"name":{"$contains":"Acme Inc"}}. Supports operators $eq, $contains, $starts_with, $ends_with.',
    },
    sorts: {
      type: 'array',
      description:
        'Attio sorts array, passed through as-is. Example: [{"attribute":"name","direction":"asc"}].',
    },
  },
  required: ['object'],
};

const SEARCH_RECORDS_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description:
        'Fuzzy search string matched against names, domains, emails, phone numbers, and social handles across people and companies.',
    },
  },
  required: ['query'],
};

const GET_RECORD_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    object: {
      type: 'string',
      description: 'The object slug, e.g. "companies" or "people".',
    },
    recordId: {
      type: 'string',
      description: 'The id of the record to fetch.',
    },
  },
  required: ['object', 'recordId'],
};

const EMPTY_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {},
};

export const ATTIO_LIST_OBJECTS_DEFINITION: ToolDefinition = {
  name: 'attio_list_objects',
  description:
    'List the objects (record types) configured in the Attio workspace, e.g. companies and people. Read-only.',
  inputSchema: EMPTY_INPUT_SCHEMA,
};

export const ATTIO_QUERY_RECORDS_DEFINITION: ToolDefinition = {
  name: 'attio_query_records',
  description:
    'Find or query records for an Attio object (by slug, e.g. "companies" or "people"). To find a specific company, person, or deal, ALWAYS pass a `filter` (typically by name) with a small `limit` — do not omit the filter to list everything and scan it yourself. An unfiltered query returns only an arbitrary first page (default 25) and is rarely what you want; reach for a name/domain filter first. Supports server-side `filter`, `sorts`, and pagination. Read-only.',
  inputSchema: QUERY_RECORDS_INPUT_SCHEMA,
};

export const ATTIO_SEARCH_RECORDS_DEFINITION: ToolDefinition = {
  name: 'attio_search_records',
  description:
    'Fuzzy-search Attio records across people and companies by a free-text query (matches names, domains, emails, phone numbers, social handles). Read-only.',
  inputSchema: SEARCH_RECORDS_INPUT_SCHEMA,
};

export const ATTIO_GET_RECORD_DEFINITION: ToolDefinition = {
  name: 'attio_get_record',
  description: 'Fetch a single Attio record by object slug and record id. Read-only.',
  inputSchema: GET_RECORD_INPUT_SCHEMA,
};

export const ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION: ToolDefinition = {
  name: 'attio_list_workspace_members',
  description: 'List the members of the Attio workspace. Read-only.',
  inputSchema: EMPTY_INPUT_SCHEMA,
};

function buildListObjectsHandler(config: AttioToolsConfig) {
  return async (_args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await listObjects(config, signal));
}

function buildQueryRecordsHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await queryRecords(config, args, signal));
}

function buildSearchRecordsHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await searchRecords(config, args, signal));
}

function buildGetRecordHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await getRecord(config, args, signal));
}

function buildListWorkspaceMembersHandler(config: AttioToolsConfig) {
  return async (_args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await listWorkspaceMembers(config, signal));
}

export function createAttioTools(config: AttioToolsConfig): AgentTool[] {
  validateConfig(config);

  return [
    {
      kind: 'string',
      definition: ATTIO_LIST_OBJECTS_DEFINITION,
      handler: buildListObjectsHandler(config),
    },
    {
      kind: 'string',
      definition: ATTIO_QUERY_RECORDS_DEFINITION,
      handler: buildQueryRecordsHandler(config),
    },
    {
      kind: 'string',
      definition: ATTIO_SEARCH_RECORDS_DEFINITION,
      handler: buildSearchRecordsHandler(config),
    },
    {
      kind: 'string',
      definition: ATTIO_GET_RECORD_DEFINITION,
      handler: buildGetRecordHandler(config),
    },
    {
      kind: 'string',
      definition: ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION,
      handler: buildListWorkspaceMembersHandler(config),
    },
  ];
}

function handlerForDefinition(config: AttioToolsConfig, name: string) {
  switch (name) {
    case ATTIO_LIST_OBJECTS_DEFINITION.name:
      return buildListObjectsHandler(config);
    case ATTIO_QUERY_RECORDS_DEFINITION.name:
      return buildQueryRecordsHandler(config);
    case ATTIO_SEARCH_RECORDS_DEFINITION.name:
      return buildSearchRecordsHandler(config);
    case ATTIO_GET_RECORD_DEFINITION.name:
      return buildGetRecordHandler(config);
    case ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION.name:
      return buildListWorkspaceMembersHandler(config);
    default:
      throw new Error(`Unknown attio tool: ${name}`);
  }
}

function createAttioToolFor(config: AttioToolsConfig, definition: ToolDefinition): AgentTool[] {
  validateConfig(config);
  return [
    {
      kind: 'string',
      definition,
      handler: handlerForDefinition(config, definition.name),
    },
  ];
}

function resolveBaseUrl(config: { apiKey: string; baseURL: string }): AttioToolsConfig {
  const base: AttioToolsConfig = { apiKey: config.apiKey };
  if (config.baseURL.length > 0) {
    base.baseUrl = config.baseURL;
  }
  return base;
}

/**
 * Hub tool registry entries for attio. Each entry declares the tool definition,
 * the Interchange provider name for credential resolution, and a factory that
 * returns the AgentTool handlers given resolved credentials.
 *
 * Import and spread into the hub's KNOWN_TOOLS to register. No hub logic changes
 * are needed when new entries are added here.
 */
export const ATTIO_HUB_TOOLS = {
  attio_list_objects: {
    definition: ATTIO_LIST_OBJECTS_DEFINITION,
    providerName: 'attio' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_LIST_OBJECTS_DEFINITION),
  },
  attio_query_records: {
    definition: ATTIO_QUERY_RECORDS_DEFINITION,
    providerName: 'attio' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_QUERY_RECORDS_DEFINITION),
  },
  attio_search_records: {
    definition: ATTIO_SEARCH_RECORDS_DEFINITION,
    providerName: 'attio' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_SEARCH_RECORDS_DEFINITION),
  },
  attio_get_record: {
    definition: ATTIO_GET_RECORD_DEFINITION,
    providerName: 'attio' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_GET_RECORD_DEFINITION),
  },
  attio_list_workspace_members: {
    definition: ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION,
    providerName: 'attio' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION),
  },
};
