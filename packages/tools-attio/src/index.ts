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

function buildConvenienceFilter(args: Record<string, unknown>): Record<string, unknown> | null {
  const filter: Record<string, unknown> = {};
  const nameContains = optionalString(args.nameContains);
  if (nameContains !== null) {
    filter.name = { $contains: nameContains };
  }
  const domainContains = optionalString(args.domainContains);
  if (domainContains !== null) {
    filter.domains = { domain: { $contains: domainContains } };
  }
  return Object.keys(filter).length > 0 ? filter : null;
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
  } else {
    const convenienceFilter = buildConvenienceFilter(args);
    if (convenienceFilter !== null) {
      body.filter = convenienceFilter;
    }
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
  const url = attioUrl(config, '/v2/workspace_members');
  return parseDataResponse(await fetchAttioJSON(config, url, { method: 'GET' }, signal));
}

const QUERY_RECORDS_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    object: {
      type: 'string',
      description: 'The object slug to query, e.g. "companies" or "people".',
    },
    nameContains: {
      type: 'string',
      description:
        'Look up records whose name contains this text — the simplest way to find a specific company or person by name (e.g. "Tribe Capital"). Prefer this over `filter` for a plain name lookup; it is mapped to a name filter for you. Ignored if `filter` is also passed.',
    },
    domainContains: {
      type: 'string',
      description:
        'Look up companies whose domain contains this text — use to find a company by website (e.g. "tribecap.com"). Mapped to the Attio domains sub-attribute filter for you. Ignored if `filter` is also passed.',
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
        'Advanced Attio filter, passed through as-is — use only when `nameContains`/`domainContains` are not enough. Keys are attribute slugs (e.g. "name", "domains"); each maps to an operator object. Example: {"name":{"$contains":"Tribe Capital"}}. Multiple attributes are combined with implicit AND.',
      additionalProperties: {
        type: 'object',
        description: 'Operator constraints for one attribute. Provide at least one operator.',
        properties: {
          $eq: { type: 'string', description: 'Exact match.' },
          $contains: { type: 'string', description: 'Substring match.' },
          $starts_with: { type: 'string', description: 'Prefix match.' },
          $ends_with: { type: 'string', description: 'Suffix match.' },
        },
      },
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
    'Find or query records for an Attio object (by slug, e.g. "companies" or "people"). To find a specific company or person, pass `nameContains` (or `domainContains`) — the simplest way to look one up by name or website. Do NOT call this with only `object`: an unfiltered query returns an arbitrary first page (default 25) and is rarely what you want. Use `filter` only for advanced multi-attribute queries. Supports `sorts` and pagination. Returns an array of records, each with an `id` (containing `record_id`) and a `values` map of attributes. Read-only.',
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
