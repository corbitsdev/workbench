import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type AttioFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type AttioToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: AttioFetch;
};

const DEFAULT_BASE_URL = "https://api.attio.com";
const DEFAULT_LIMIT = 25;
const DEFAULT_OFFSET = 0;
const MAX_LIMIT = 100;
// The notes list endpoint caps `limit` at 50 (unlike records/tasks at 100);
// requesting more can be rejected. Used by the idempotency preflight.
const NOTES_MAX_LIMIT = 50;

function attioHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
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

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function optionalNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDataResponse(value: unknown): unknown {
  if (!isRecord(value) || !("data" in value)) {
    throw new Error("Attio response is missing the data field");
  }
  return value.data;
}

function validateConfig(config: AttioToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Attio apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Attio baseUrl must be a valid URL");
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

function attioUrl(config: AttioToolsConfig, path: string): URL {
  return new URL(
    `${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}${path}`,
  );
}

async function fetchAttioJSON(
  config: AttioToolsConfig,
  url: URL,
  init: { method: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown },
  signal: AbortSignal,
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
    const bodyText = errorMessageFromBody(
      await response.text().catch(() => ""),
    );
    const detail = response.statusText || bodyText;
    throw new Error(`Attio API error: ${response.status} ${detail ?? ""}`);
  }

  const data: unknown = await response.json();
  return data;
}

async function listObjects(
  config: AttioToolsConfig,
  signal: AbortSignal,
): Promise<unknown> {
  const url = attioUrl(config, "/v2/objects");
  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "GET" }, signal),
  );
}

function buildConvenienceFilter(
  args: Record<string, unknown>,
): Record<string, unknown> | null {
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
  signal: AbortSignal,
): Promise<unknown> {
  const object = optionalString(args.object);
  if (object === null) {
    throw new Error("object is required");
  }

  const limit = optionalPositiveInteger(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = optionalNonNegativeInteger(args.offset, DEFAULT_OFFSET);

  const url = attioUrl(
    config,
    `/v2/objects/${encodeURIComponent(object)}/records/query`,
  );
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
  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "POST", body }, signal),
  );
}

async function searchRecords(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const query = optionalString(args.query);
  if (query === null) {
    throw new Error("query is required");
  }

  const url = attioUrl(config, "/v2/records/search");
  const body = { query };
  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "POST", body }, signal),
  );
}

async function getRecord(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const object = optionalString(args.object);
  if (object === null) {
    throw new Error("object is required");
  }
  const recordId = optionalString(args.recordId);
  if (recordId === null) {
    throw new Error("recordId is required");
  }

  const url = attioUrl(
    config,
    `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`,
  );
  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "GET" }, signal),
  );
}

async function listWorkspaceMembers(
  config: AttioToolsConfig,
  signal: AbortSignal,
): Promise<unknown> {
  const url = attioUrl(config, "/v2/workspace_members");
  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "GET" }, signal),
  );
}

async function listTasks(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const limit = optionalPositiveInteger(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = optionalNonNegativeInteger(args.offset, DEFAULT_OFFSET);

  const url = attioUrl(config, "/v2/tasks");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const assignee = optionalString(args.assignee);
  if (assignee !== null) {
    url.searchParams.set("assignee", assignee);
  }
  if (typeof args.isCompleted === "boolean") {
    url.searchParams.set("is_completed", String(args.isCompleted));
  }
  const linkedObject = optionalString(args.linkedObject);
  if (linkedObject !== null) {
    url.searchParams.set("linked_object", linkedObject);
  }
  const linkedRecordId = optionalString(args.linkedRecordId);
  if (linkedRecordId !== null) {
    url.searchParams.set("linked_record_id", linkedRecordId);
  }
  const sort = optionalString(args.sort);
  if (sort !== null) {
    url.searchParams.set("sort", sort);
  }

  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "GET" }, signal),
  );
}

type LinkedRecordRef = Record<string, unknown> & {
  target_object?: unknown;
  target_object_id?: unknown;
  target_record_id?: unknown;
};

function linkedRecordRefs(task: unknown): LinkedRecordRef[] {
  if (!isRecord(task) || !Array.isArray(task.linked_records)) {
    return [];
  }
  return task.linked_records.filter(isRecord) as LinkedRecordRef[];
}

// Normalize a raw Attio linked-record ref to `{ object, recordId }` — the one
// shape the rest of the system (canonical AttioLinkedRecordSchema, the workflow
// UI) reads. Emitting the raw `target_*` keys here is what let the UI parser
// drift and silently fail (CL-2622 review); the tool is the right place to
// normalize so there is a single shape end to end.
function normalizeRef(
  ref: LinkedRecordRef,
): { object: string; recordId: string } | null {
  const object =
    optionalString(ref.target_object) ?? optionalString(ref.target_object_id);
  const recordId = optionalString(ref.target_record_id);
  if (object === null || recordId === null) return null;
  return { object, recordId };
}

async function hydrateLinkedRecord(
  config: AttioToolsConfig,
  ref: LinkedRecordRef,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const normalized = normalizeRef(ref);
  if (normalized === null) {
    return { error: "linked record is missing object or record id" };
  }
  try {
    const record = await getRecord(config, normalized, signal);
    return { ...normalized, record };
  } catch (err) {
    return {
      ...normalized,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getTask(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const taskId = optionalString(args.taskId);
  if (taskId === null) {
    throw new Error("taskId is required");
  }

  const url = attioUrl(config, `/v2/tasks/${encodeURIComponent(taskId)}`);
  const task = parseDataResponse(
    await fetchAttioJSON(config, url, { method: "GET" }, signal),
  );

  const refs = linkedRecordRefs(task);
  if (args.hydrateLinkedRecords === false) {
    return {
      task,
      linkedRecords: refs.map(normalizeRef).filter((r) => r !== null),
    };
  }

  const linkedRecords = await Promise.all(
    refs.map((ref) => hydrateLinkedRecord(config, ref, signal)),
  );
  return { task, linkedRecords };
}

async function updateTask(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const taskId = optionalString(args.taskId);
  if (taskId === null) {
    throw new Error("taskId is required");
  }

  const data: Record<string, unknown> = {};
  if (typeof args.isCompleted === "boolean") {
    data.is_completed = args.isCompleted;
  }
  const deadlineAt = optionalString(args.deadlineAt);
  if (deadlineAt !== null) {
    data.deadline_at = deadlineAt;
  }
  if (Object.keys(data).length === 0) {
    throw new Error(
      "no task fields to update (pass isCompleted or deadlineAt)",
    );
  }

  const url = attioUrl(config, `/v2/tasks/${encodeURIComponent(taskId)}`);
  return parseDataResponse(
    await fetchAttioJSON(
      config,
      url,
      { method: "PATCH", body: { data } },
      signal,
    ),
  );
}

// Workbench-internal brief-source self-skip contract (see
// BriefSourceFetchInputSchema / BRIEF_SOURCE_SKIPPED_MARKER in
// @workbench/shared). Duplicated locally rather than imported — this package
// has no dependency on @workbench/shared, following the tools-granola
// precedent.
const BRIEF_SOURCE_SKIPPED_MARKER = { skipped: true as const };

function isBriefSourceFetchEnabled(
  sourceKey: string,
  enabledSources: string[] | undefined,
): boolean {
  return enabledSources === undefined || enabledSources.includes(sourceKey);
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function attributeValue(record: unknown, attribute: string): string | null {
  if (!isRecord(record) || !isRecord(record.values)) {
    return null;
  }
  const entries = record.values[attribute];
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const first = entries[0];
  if (isRecord(first) && typeof first.value === "string") {
    return first.value;
  }
  return null;
}

function recordId(record: unknown): string | null {
  if (!isRecord(record) || !isRecord(record.id)) {
    return null;
  }
  return optionalString(record.id.record_id);
}

function compactCompany(record: unknown): {
  id: string | null;
  name: string | null;
  createdAt: string | null;
  url: string | null;
} {
  return {
    id: recordId(record),
    name: attributeValue(record, "name"),
    createdAt:
      isRecord(record) && typeof record.created_at === "string"
        ? record.created_at
        : null,
    // Attio's record API returns a top-level `web_url` with the record's
    // canonical Attio deep link — normalized to `url` here so the heartbeat's
    // clickable-links prompt rule (CL-3504) can operate on a guaranteed field
    // name across every brief source rather than a source-specific key.
    url:
      isRecord(record) && typeof record.web_url === "string"
        ? record.web_url
        : null,
  };
}

function compactTask(task: unknown): {
  id: string | null;
  content: string | null;
  deadlineAt: string | null;
} {
  return {
    id:
      isRecord(task) && isRecord(task.id) && typeof task.id.task_id === "string"
        ? task.id.task_id
        : null,
    content:
      isRecord(task) && typeof task.content_plaintext === "string"
        ? task.content_plaintext
        : null,
    deadlineAt:
      isRecord(task) && typeof task.deadline_at === "string"
        ? task.deadline_at
        : null,
  };
}

async function recentActivity(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const enabledSources = optionalStringArray(args.enabledSources);
  if (!isBriefSourceFetchEnabled("attio", enabledSources)) {
    return BRIEF_SOURCE_SKIPPED_MARKER;
  }

  const createdAfter = optionalString(args.createdAfter);

  const companiesUrl = attioUrl(config, "/v2/objects/companies/records/query");
  const companiesBody: Record<string, unknown> = {
    limit: DEFAULT_LIMIT,
    offset: DEFAULT_OFFSET,
    sorts: [{ attribute: "created_at", direction: "desc" }],
  };
  if (createdAfter !== null) {
    companiesBody.filter = { created_at: { $gte: createdAfter } };
  }
  const companiesRaw = await fetchAttioJSON(
    config,
    companiesUrl,
    { method: "POST", body: companiesBody },
    signal,
  );
  const companies = parseDataResponse(companiesRaw);

  const tasksUrl = attioUrl(config, "/v2/tasks");
  tasksUrl.searchParams.set("limit", String(DEFAULT_LIMIT));
  tasksUrl.searchParams.set("offset", String(DEFAULT_OFFSET));
  tasksUrl.searchParams.set("is_completed", "false");
  const tasksRaw = await fetchAttioJSON(
    config,
    tasksUrl,
    { method: "GET" },
    signal,
  );
  const tasks = parseDataResponse(tasksRaw);

  return {
    attioActivity: {
      newCompanies: Array.isArray(companies)
        ? companies.map(compactCompany)
        : [],
      openTasks: Array.isArray(tasks) ? tasks.map(compactTask) : [],
    },
  };
}

function idempotencyMarker(key: string): string {
  return `<!-- idem:${key} -->`;
}

// Attio note create takes a single `content` string, but list responses expose
// the body under content_plaintext / content_markdown (and sometimes a nested
// `content`). Scan every string leaf so the marker is found regardless of which
// field the API populated for the note's format.
function noteContainsMarker(note: unknown, marker: string): boolean {
  if (typeof note === "string") {
    return note.includes(marker);
  }
  if (Array.isArray(note)) {
    return note.some((item) => noteContainsMarker(item, marker));
  }
  if (isRecord(note)) {
    return Object.values(note).some((value) =>
      noteContainsMarker(value, marker),
    );
  }
  return false;
}

async function findNoteByMarker(
  config: AttioToolsConfig,
  parentObject: string,
  parentRecordId: string,
  marker: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  const url = attioUrl(config, "/v2/notes");
  url.searchParams.set("parent_object", parentObject);
  url.searchParams.set("parent_record_id", parentRecordId);
  url.searchParams.set("limit", String(NOTES_MAX_LIMIT));
  url.searchParams.set("offset", String(DEFAULT_OFFSET));

  const notes = parseDataResponse(
    await fetchAttioJSON(config, url, { method: "GET" }, signal),
  );
  if (!Array.isArray(notes)) {
    return null;
  }
  return notes.find((note) => noteContainsMarker(note, marker)) ?? null;
}

async function createNote(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const parentObject = optionalString(args.parentObject);
  if (parentObject === null) {
    throw new Error("parentObject is required");
  }
  const parentRecordId = optionalString(args.parentRecordId);
  if (parentRecordId === null) {
    throw new Error("parentRecordId is required");
  }
  const content = optionalString(args.content);
  if (content === null) {
    throw new Error("content is required");
  }
  const format = optionalString(args.format) ?? "markdown";
  if (format !== "markdown" && format !== "plaintext") {
    throw new Error('format must be "plaintext" or "markdown"');
  }

  const idempotencyKey = optionalString(args.idempotencyKey);
  let noteContent = content;
  if (idempotencyKey !== null) {
    const marker = idempotencyMarker(idempotencyKey);
    const existing = await findNoteByMarker(
      config,
      parentObject,
      parentRecordId,
      marker,
      signal,
    );
    if (existing !== null) {
      return { deduped: true, note: existing };
    }
    noteContent = `${content}\n\n${marker}`;
  }

  const url = attioUrl(config, "/v2/notes");
  const body = {
    data: {
      parent_object: parentObject,
      parent_record_id: parentRecordId,
      title: optionalString(args.title) ?? "",
      format,
      content: noteContent,
    },
  };
  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "POST", body }, signal),
  );
}

async function createRecord(
  config: AttioToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const object = optionalString(args.object);
  if (object === null) {
    throw new Error("object is required");
  }
  if (!isRecord(args.values) || Object.keys(args.values).length === 0) {
    throw new Error("values is required (a non-empty attribute map)");
  }

  const url = attioUrl(
    config,
    `/v2/objects/${encodeURIComponent(object)}/records`,
  );
  const body = { data: { values: args.values } };

  // With a matchingAttribute, use Attio's assert (upsert) endpoint so a retried
  // create matches an existing record instead of duplicating it.
  const matchingAttribute = optionalString(args.matchingAttribute);
  if (matchingAttribute !== null) {
    url.searchParams.set("matching_attribute", matchingAttribute);
    return parseDataResponse(
      await fetchAttioJSON(config, url, { method: "PUT", body }, signal),
    );
  }

  return parseDataResponse(
    await fetchAttioJSON(config, url, { method: "POST", body }, signal),
  );
}

const QUERY_RECORDS_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    object: {
      type: "string",
      description: 'The object slug to query, e.g. "companies" or "people".',
    },
    nameContains: {
      type: "string",
      description:
        'Look up records whose name contains this text — the simplest way to find a specific company or person by name (e.g. "Tribe Capital"). Prefer this over `filter` for a plain name lookup; it is mapped to a name filter for you. Ignored if `filter` is also passed.',
    },
    domainContains: {
      type: "string",
      description:
        'Look up companies whose domain contains this text — use to find a company by website (e.g. "tribecap.com"). Mapped to the Attio domains sub-attribute filter for you. Ignored if `filter` is also passed.',
    },
    limit: {
      type: "number",
      description: "Maximum number of records to return (1-100, default 25).",
    },
    offset: {
      type: "number",
      description: "Number of records to skip for pagination (default 0).",
    },
    filter: {
      type: "object",
      description:
        'Advanced Attio filter, passed through as-is — use only when `nameContains`/`domainContains` are not enough. Keys are attribute slugs (e.g. "name", "domains"); each maps to an operator object. Example: {"name":{"$contains":"Tribe Capital"}}. Multiple attributes are combined with implicit AND.',
      additionalProperties: {
        type: "object",
        description:
          "Operator constraints for one attribute. Provide at least one operator.",
        properties: {
          $eq: { type: "string", description: "Exact match." },
          $contains: { type: "string", description: "Substring match." },
          $starts_with: { type: "string", description: "Prefix match." },
          $ends_with: { type: "string", description: "Suffix match." },
        },
      },
    },
    sorts: {
      type: "array",
      description:
        'Attio sorts array, passed through as-is. Example: [{"attribute":"name","direction":"asc"}].',
    },
  },
  required: ["object"],
};

const SEARCH_RECORDS_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description:
        "Fuzzy search string matched against names, domains, emails, phone numbers, and social handles across people and companies.",
    },
  },
  required: ["query"],
};

const GET_RECORD_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    object: {
      type: "string",
      description: 'The object slug, e.g. "companies" or "people".',
    },
    recordId: {
      type: "string",
      description: "The id of the record to fetch.",
    },
  },
  required: ["object", "recordId"],
};

const LIST_TASKS_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    assignee: {
      type: "string",
      description:
        'Scope tasks to one assignee — pass a workspace member email (e.g. "sawyer@abklabs.com") or workspace member id. Use this to list only the tasks assigned to a specific person.',
    },
    isCompleted: {
      type: "boolean",
      description:
        "Filter by completion state: false for open tasks, true for completed. Omit to return both.",
    },
    linkedObject: {
      type: "string",
      description:
        'Only return tasks linked to this object slug (e.g. "companies"). Use with linkedRecordId to scope to one record.',
    },
    linkedRecordId: {
      type: "string",
      description: "Only return tasks linked to this record id.",
    },
    sort: {
      type: "string",
      description:
        'Sort order, e.g. "created_at:desc" (newest first) or "created_at:asc".',
    },
    limit: {
      type: "number",
      description: "Maximum number of tasks to return (1-100, default 25).",
    },
    offset: {
      type: "number",
      description: "Number of tasks to skip for pagination (default 0).",
    },
  },
};

const GET_TASK_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    taskId: {
      type: "string",
      description: "The id of the task to fetch.",
    },
    hydrateLinkedRecords: {
      type: "boolean",
      description:
        "When true (default), fetch each linked record's full data so you get the company/person context in one call. Set false to return only the linked-record references.",
    },
  },
  required: ["taskId"],
};

const UPDATE_TASK_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    taskId: {
      type: "string",
      description: "The id of the task to update.",
    },
    isCompleted: {
      type: "boolean",
      description: "Set the task's completion state (e.g. true to mark done).",
    },
    deadlineAt: {
      type: "string",
      description: "Set the task deadline (ISO 8601 timestamp).",
    },
  },
  required: ["taskId"],
};

const CREATE_NOTE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    parentObject: {
      type: "string",
      description:
        'The object slug the note is attached to, e.g. "companies" or "people".',
    },
    parentRecordId: {
      type: "string",
      description: "The id of the record the note is attached to.",
    },
    content: {
      type: "string",
      description: "The note body.",
    },
    title: {
      type: "string",
      description: "Optional note title (defaults to empty).",
    },
    format: {
      type: "string",
      description: 'Content format: "markdown" (default) or "plaintext".',
    },
    idempotencyKey: {
      type: "string",
      description:
        "Optional dedupe key. When set, a hidden marker carrying this key is appended to the note body on create; before creating, existing notes on the same record are checked for that marker and, if one is found, the create is skipped and the existing note is returned as `{ deduped: true, note }`. Pass a stable key (e.g. a workflow run id) so re-running after a failed write-back cannot create a duplicate note.",
    },
  },
  required: ["parentObject", "parentRecordId", "content"],
};

const CREATE_RECORD_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    object: {
      type: "string",
      description:
        'The object slug to create a record for, e.g. "companies" or "people".',
    },
    values: {
      type: "object",
      description:
        'The attribute values for the new record, keyed by attribute slug. Each value follows the Attio write format for that attribute type — e.g. {"name":"Tribe Capital","domains":["tribecap.com"]}. Must contain at least one attribute.',
    },
    matchingAttribute: {
      type: "string",
      description:
        "Optional attribute slug to match on for an idempotent upsert. When set, an existing record whose value for this attribute matches `values` is updated instead of creating a duplicate (Attio assert). Pass a naturally unique attribute (e.g. a domain or email) so retrying a failed create cannot make a duplicate.",
    },
  },
  required: ["object", "values"],
};

const EMPTY_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {},
};

export const ATTIO_LIST_OBJECTS_DEFINITION: ToolDefinition = {
  name: "attio_list_objects",
  description:
    "List the objects (record types) configured in the Attio workspace, e.g. companies and people. Read-only.",
  inputSchema: EMPTY_INPUT_SCHEMA,
};

export const ATTIO_QUERY_RECORDS_DEFINITION: ToolDefinition = {
  name: "attio_query_records",
  description:
    'Find or query records for an Attio object (by slug, e.g. "companies" or "people"). To find a specific company or person, pass `nameContains` (or `domainContains`) — the simplest way to look one up by name or website. Do NOT call this with only `object`: an unfiltered query returns an arbitrary first page (default 25) and is rarely what you want. Use `filter` only for advanced multi-attribute queries. Supports `sorts` and pagination. Returns an array of records, each with an `id` (containing `record_id`) and a `values` map of attributes. Read-only.',
  inputSchema: QUERY_RECORDS_INPUT_SCHEMA,
};

export const ATTIO_SEARCH_RECORDS_DEFINITION: ToolDefinition = {
  name: "attio_search_records",
  description:
    "Fuzzy-search Attio records across people and companies by a free-text query (matches names, domains, emails, phone numbers, social handles). Read-only.",
  inputSchema: SEARCH_RECORDS_INPUT_SCHEMA,
};

export const ATTIO_GET_RECORD_DEFINITION: ToolDefinition = {
  name: "attio_get_record",
  description:
    "Fetch a single Attio record by object slug and record id. Read-only.",
  inputSchema: GET_RECORD_INPUT_SCHEMA,
};

export const ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION: ToolDefinition = {
  name: "attio_list_workspace_members",
  description: "List the members of the Attio workspace. Read-only.",
  inputSchema: EMPTY_INPUT_SCHEMA,
};

export const ATTIO_LIST_TASKS_DEFINITION: ToolDefinition = {
  name: "attio_list_tasks",
  description:
    'List Attio tasks. To scope to one person\'s tasks (e.g. "my tasks"), pass `assignee` with their workspace member email or id. Filter open work with `isCompleted: false`, or scope to a record with `linkedObject`+`linkedRecordId`. Supports `sort` and pagination. Returns an array of tasks, each with an `id` (containing `task_id`), `content_plaintext`, `deadline_at`, `is_completed`, `assignees`, and `linked_records`. Read-only.',
  inputSchema: LIST_TASKS_INPUT_SCHEMA,
};

export const ATTIO_GET_TASK_DEFINITION: ToolDefinition = {
  name: "attio_get_task",
  description:
    "Fetch a single Attio task by id and, by default, hydrate its linked records so you get the full company/person context in one call. Returns `{ task, linkedRecords }` where each linked record includes the fetched `record` (or an `error` if it could not be fetched). Read-only.",
  inputSchema: GET_TASK_INPUT_SCHEMA,
};

export const ATTIO_UPDATE_TASK_DEFINITION: ToolDefinition = {
  name: "attio_update_task",
  description:
    "Update an Attio task — set its completion state (`isCompleted`) and/or `deadlineAt`. WRITES to Attio: use only after explicit human approval.",
  inputSchema: UPDATE_TASK_INPUT_SCHEMA,
};

export const ATTIO_CREATE_NOTE_DEFINITION: ToolDefinition = {
  name: "attio_create_note",
  description:
    "Create a note on an Attio record (e.g. attach approved outreach copy to a company). WRITES to Attio: use only after explicit human approval. Pass `idempotencyKey` to make the write safe to retry — a matching prior note is returned instead of creating a duplicate.",
  inputSchema: CREATE_NOTE_INPUT_SCHEMA,
};

export const ATTIO_CREATE_RECORD_DEFINITION: ToolDefinition = {
  name: "attio_create_record",
  description:
    "Create a record for an Attio object (e.g. add a new company or person). Pass `object` (the slug) and `values` (attribute map). WRITES to Attio: use only after explicit human approval. Pass `matchingAttribute` to make the write safe to retry — a record matching that attribute is updated instead of creating a duplicate. Returns the created (or matched) record with its `id` and `values`.",
  inputSchema: CREATE_RECORD_INPUT_SCHEMA,
};

const RECENT_ACTIVITY_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    createdAfter: {
      type: "string",
      description: "Return only companies created after this ISO date-time.",
    },
    enabledSources: {
      type: "array",
      items: { type: "string" },
      description:
        'Workbench-internal: the calling member\'s currently-enabled brief source keys. When set and it omits "attio", this call is skipped (returns a `{ skipped: true }` result) instead of hitting the Attio API.',
    },
  },
};

export const ATTIO_RECENT_ACTIVITY_DEFINITION: ToolDefinition = {
  name: "attio_recent_activity",
  description:
    "Compact snapshot of recent Attio CRM activity: companies created since createdAfter and currently open tasks. Read-only.",
  inputSchema: RECENT_ACTIVITY_INPUT_SCHEMA,
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

function buildListTasksHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await listTasks(config, args, signal));
}

function buildGetTaskHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await getTask(config, args, signal));
}

function buildUpdateTaskHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await updateTask(config, args, signal));
}

function buildCreateNoteHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await createNote(config, args, signal));
}

function buildCreateRecordHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await createRecord(config, args, signal));
}

function buildRecentActivityHandler(config: AttioToolsConfig) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await recentActivity(config, args, signal));
}

export function createAttioTools(config: AttioToolsConfig): AgentTool[] {
  validateConfig(config);

  return [
    {
      kind: "string",
      definition: ATTIO_LIST_OBJECTS_DEFINITION,
      handler: buildListObjectsHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_QUERY_RECORDS_DEFINITION,
      handler: buildQueryRecordsHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_SEARCH_RECORDS_DEFINITION,
      handler: buildSearchRecordsHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_GET_RECORD_DEFINITION,
      handler: buildGetRecordHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION,
      handler: buildListWorkspaceMembersHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_LIST_TASKS_DEFINITION,
      handler: buildListTasksHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_GET_TASK_DEFINITION,
      handler: buildGetTaskHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_UPDATE_TASK_DEFINITION,
      handler: buildUpdateTaskHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_CREATE_NOTE_DEFINITION,
      handler: buildCreateNoteHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_CREATE_RECORD_DEFINITION,
      handler: buildCreateRecordHandler(config),
    },
    {
      kind: "string",
      definition: ATTIO_RECENT_ACTIVITY_DEFINITION,
      handler: buildRecentActivityHandler(config),
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
    case ATTIO_LIST_TASKS_DEFINITION.name:
      return buildListTasksHandler(config);
    case ATTIO_GET_TASK_DEFINITION.name:
      return buildGetTaskHandler(config);
    case ATTIO_UPDATE_TASK_DEFINITION.name:
      return buildUpdateTaskHandler(config);
    case ATTIO_CREATE_NOTE_DEFINITION.name:
      return buildCreateNoteHandler(config);
    case ATTIO_CREATE_RECORD_DEFINITION.name:
      return buildCreateRecordHandler(config);
    case ATTIO_RECENT_ACTIVITY_DEFINITION.name:
      return buildRecentActivityHandler(config);
    default:
      throw new Error(`Unknown attio tool: ${name}`);
  }
}

function createAttioToolFor(
  config: AttioToolsConfig,
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
}): AttioToolsConfig {
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
    sideEffect: "read" as const,
    definition: ATTIO_LIST_OBJECTS_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_LIST_OBJECTS_DEFINITION),
  },
  attio_query_records: {
    sideEffect: "read" as const,
    definition: ATTIO_QUERY_RECORDS_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(
        resolveBaseUrl(config),
        ATTIO_QUERY_RECORDS_DEFINITION,
      ),
  },
  attio_search_records: {
    sideEffect: "read" as const,
    definition: ATTIO_SEARCH_RECORDS_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(
        resolveBaseUrl(config),
        ATTIO_SEARCH_RECORDS_DEFINITION,
      ),
  },
  attio_get_record: {
    sideEffect: "read" as const,
    definition: ATTIO_GET_RECORD_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_GET_RECORD_DEFINITION),
  },
  attio_list_workspace_members: {
    sideEffect: "read" as const,
    definition: ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(
        resolveBaseUrl(config),
        ATTIO_LIST_WORKSPACE_MEMBERS_DEFINITION,
      ),
  },
  attio_list_tasks: {
    sideEffect: "read" as const,
    definition: ATTIO_LIST_TASKS_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_LIST_TASKS_DEFINITION),
  },
  attio_get_task: {
    sideEffect: "read" as const,
    definition: ATTIO_GET_TASK_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_GET_TASK_DEFINITION),
  },
  attio_update_task: {
    sideEffect: "write" as const,
    definition: ATTIO_UPDATE_TASK_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_UPDATE_TASK_DEFINITION),
  },
  attio_create_note: {
    sideEffect: "write" as const,
    definition: ATTIO_CREATE_NOTE_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(resolveBaseUrl(config), ATTIO_CREATE_NOTE_DEFINITION),
  },
  attio_create_record: {
    sideEffect: "write" as const,
    definition: ATTIO_CREATE_RECORD_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(
        resolveBaseUrl(config),
        ATTIO_CREATE_RECORD_DEFINITION,
      ),
  },
  attio_recent_activity: {
    sideEffect: "read" as const,
    definition: ATTIO_RECENT_ACTIVITY_DEFINITION,
    providerName: "attio" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createAttioToolFor(
        resolveBaseUrl(config),
        ATTIO_RECENT_ACTIVITY_DEFINITION,
      ),
  },
};
