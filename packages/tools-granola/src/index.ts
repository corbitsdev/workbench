import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 30;
// Bounds the internal pagination the heartbeat brief path performs per date
// filter (created_after, updated_after) so an unbounded cursor loop can never
// run away against a runaway API response.
const BRIEF_MAX_PAGES_PER_QUERY = 5;

/**
 * Granola's public API base URL. Owned by the tool package so callers only
 * need to supply an API key — the base URL is pulled in here rather than
 * stored per credential. Override is still possible via `baseUrl`.
 */
export const GRANOLA_DEFAULT_BASE_URL = "https://public-api.granola.ai/v1";

// GranolaFetch and GranolaToolsConfig are left as plain types: they contain
// function fields (fetcher?: GranolaFetch) which are non-JSON-expressible and
// cannot be represented as arktype schemas.
export type GranolaFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type GranolaToolsConfig = {
  apiKey: string;
  /** Defaults to {@link GRANOLA_DEFAULT_BASE_URL} when omitted or empty. */
  baseUrl?: string;
  fetcher?: GranolaFetch;
};

// ResolvedGranolaConfig is an internal/trusted shape with a function field —
// left as a plain type for the same reason as GranolaToolsConfig.
type ResolvedGranolaConfig = {
  apiKey: string;
  baseUrl: string;
  fetcher?: GranolaFetch;
};

// --- Arg schemas (handler input boundaries) ---

const ListNotesArgs = type({
  "limit?": "number",
  "cursor?": "string > 0",
  "createdAfter?": "string",
  "createdBefore?": "string",
  "updatedAfter?": "string",
  "folderId?": "string",
  // When present, this is the member's currently-enabled brief source keys
  // (see @workbench/shared's BRIEF_SOURCE_CATALOG). Absent means "no
  // restriction" (call as normal) — only an explicit list that omits
  // "granola" skips the call.
  "enabledSources?": "string[]",
});

const GetNoteArgs = type({ noteId: "string > 0" });

const ListFoldersArgs = type({
  "limit?": "number",
  "cursor?": "string > 0",
});

// --- External API response schemas ---

const GranolaTranscriptSpeaker = type({
  source: "'microphone' | 'speaker'",
  "diarization_label?": "string",
});

const GranolaTranscriptItem = type({
  speaker: GranolaTranscriptSpeaker,
  text: "string",
});

// NOTE: the `transcript` field here is intentionally unreachable via the
// GranolaTranscriptItem.array() path in practice.  parseNote pre-validates
// each transcript item through parseTranscriptItem (which emits legacy-
// compatible error messages) and passes already-parsed items to GranolaNote.
// The .array() declaration preserves the correct static type; a future caller
// that constructs a GranolaNote directly would hit it.
const GranolaNote = type({
  id: "string",
  title: "string | null",
  created_at: "string",
  "updated_at?": "string",
  "participants?": "string[]",
  "summary?": "string",
  "transcript?": GranolaTranscriptItem.array(),
  // Set client-side for the heartbeat brief path: true when a note's
  // created_at predates the brief cutoff but its updated_at does not — the
  // synthesizer uses this to label the note "revised" rather than "new".
  "updatedOnly?": "boolean",
});

const GranolaListResponse = type({
  notes: GranolaNote.array(),
  hasMore: "boolean",
  "cursor?": "string",
  // Set when the caller's `enabledSources` excluded "granola" — the call was
  // never made. Read by consumers (e.g. the heartbeat brief) to describe this
  // honestly as a disabled source, not a failed fetch.
  "skipped?": "boolean",
});

const GranolaFolder = type({
  id: "string",
  name: "string",
  parent_folder_id: "string | null",
});

const GranolaFolderListResponse = type({
  folders: GranolaFolder.array(),
  hasMore: "boolean",
  "cursor?": "string",
});

export type GranolaNote = typeof GranolaNote.infer;
export type GranolaTranscriptItem = typeof GranolaTranscriptItem.infer;
export type GranolaListResponse = typeof GranolaListResponse.infer;
export type GranolaFolder = typeof GranolaFolder.infer;
export type GranolaFolderListResponse = typeof GranolaFolderListResponse.infer;

function granolaHeaders(apiKey: string) {
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

// Deliberately does NOT check apiKey here: the empty-key case is a per-call
// fail-loud check in each handler below, not a construction-time concern —
// nothing ever constructs this tool with an empty key (the hub tool registry
// omits the provider entirely when the credential is missing).
function validateConfig(config: ResolvedGranolaConfig): void {
  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error("Granola baseUrl must be a valid URL");
  }
}

// Thrown when the Granola API rejects the configured key so callers can
// distinguish "credential is bad" from any other fetch/parse failure —
// only this case is eligible to degrade to a skipped result for the
// heartbeat brief; a network error, malformed response, etc. must still
// surface loudly to every caller.
class GranolaAuthError extends Error {}

const SKIPPED_LIST_RESULT: GranolaListResponse = {
  notes: [],
  hasMore: false,
  skipped: true,
};

// The heartbeat brief is the only caller that passes `enabledSources` (see
// ListNotesArgs above) — it is a workbench-internal marker of "this is the
// unattended brief path", not a general opt-in flag. Reusing it (rather than
// adding a second, overlapping opt-in argument) keeps every other caller of
// granola_list_notes — interactive chat agents, other workflows — fail-loud
// on a missing or rejected credential, which is the safer default: only a
// caller that already declared itself brief-shaped degrades silently.
function isHeartbeatShaped(args: { enabledSources?: string[] }): boolean {
  return args.enabledSources !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return text;
  }

  return text;
}

async function fetchGranolaJSON(
  config: ResolvedGranolaConfig,
  url: URL,
  signal: AbortSignal,
) {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: granolaHeaders(config.apiKey),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ""));
    const detail = response.statusText || body;
    const message = `Granola API error: ${response.status} ${detail ?? ""}`;
    if (response.status === 401 || response.status === 403) {
      throw new GranolaAuthError(message);
    }
    throw new Error(message);
  }

  const data: unknown = await response.json();
  return data;
}

function parseTranscriptItem(value: unknown): GranolaTranscriptItem {
  const parsed = GranolaTranscriptItem(value);
  if (parsed instanceof type.errors) {
    const path = parsed[0]?.path.join(".");
    if (path?.startsWith("speaker.source")) {
      throw new Error(
        "Granola response contains an invalid transcript speaker",
      );
    }
    throw new Error("Granola response contains an invalid transcript item");
  }
  return parsed;
}

function parseNote(value: unknown): GranolaNote {
  if (!isRecord(value)) {
    throw new Error("Granola response contains an invalid note");
  }

  if (typeof value.id !== "string") {
    throw new Error("Granola response missing id");
  }

  const transcript = Array.isArray(value.transcript)
    ? value.transcript.map(parseTranscriptItem)
    : undefined;

  const noteToValidate = { ...value, ...(transcript ? { transcript } : {}) };
  const parsed = GranolaNote(noteToValidate);
  if (parsed instanceof type.errors) {
    throw new Error("Granola response contains an invalid note");
  }
  return parsed;
}

function parseListResponse(value: unknown): GranolaListResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.notes) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new Error("Granola response contains an invalid notes list");
  }

  const notes = value.notes.map(parseNote);
  // Normalize cursor: null (API sentinel) → omit the key so callers checking
  // `=== undefined` see consistent "no next page" behavior.
  const { cursor: _rawCursor, ...rest } = value;
  const cursorPart =
    typeof value.cursor === "string" ? { cursor: value.cursor } : {};
  const parsed = GranolaListResponse({ ...rest, notes, ...cursorPart });
  if (parsed instanceof type.errors) {
    throw new Error("Granola response contains an invalid notes list");
  }
  return parsed;
}

function parseFolder(value: unknown): GranolaFolder {
  if (!isRecord(value)) {
    throw new Error("Granola response contains an invalid folder");
  }

  const parsed = GranolaFolder(value);
  if (parsed instanceof type.errors) {
    throw new Error("Granola response contains an invalid folder");
  }
  return parsed;
}

function parseFolderListResponse(value: unknown): GranolaFolderListResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.folders) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new Error("Granola response contains an invalid folders list");
  }

  const folders = value.folders.map(parseFolder);
  // Normalize cursor: null (API sentinel) → omit the key so callers checking
  // `=== undefined` see consistent "no next page" behavior.
  const { cursor: _rawCursor, ...rest } = value;
  const cursorPart =
    typeof value.cursor === "string" ? { cursor: value.cursor } : {};
  const parsed = GranolaFolderListResponse({
    ...rest,
    folders,
    ...cursorPart,
  });
  if (parsed instanceof type.errors) {
    throw new Error("Granola response contains an invalid folders list");
  }
  return parsed;
}

// Fetches every page (bounded by BRIEF_MAX_PAGES_PER_QUERY) of a single
// created_after/updated_after query for the heartbeat brief path, at the API's
// max page_size, following the response cursor.
async function fetchBriefPages(
  config: ResolvedGranolaConfig,
  baseUrl: string,
  dateParam: "created_after" | "updated_after",
  cutoff: string,
  createdBefore: string | null,
  folderId: string | null,
  signal: AbortSignal,
): Promise<GranolaNote[]> {
  const notes: GranolaNote[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < BRIEF_MAX_PAGES_PER_QUERY; page += 1) {
    const url = new URL(`${baseUrl}/notes`);
    url.searchParams.set("page_size", MAX_LIST_LIMIT.toString());
    url.searchParams.set(dateParam, cutoff);
    if (createdBefore !== null) {
      url.searchParams.set("created_before", createdBefore);
    }
    if (folderId !== null) {
      url.searchParams.set("folder_id", folderId);
    }
    if (cursor !== null) {
      url.searchParams.set("cursor", cursor);
    }

    const response = parseListResponse(
      await fetchGranolaJSON(config, url, signal),
    );
    notes.push(...response.notes);

    if (!response.hasMore || response.cursor === undefined) {
      break;
    }
    cursor = response.cursor;
  }

  return notes;
}

// Merges the created_after and updated_after result sets by note id: a note
// present in the created_after set is new and always wins; a note present
// only in the updated_after set predates the cutoff and is tagged
// `updatedOnly` so the synthesizer can label it revised rather than new.
// The merged result is sorted by created_at desc since the API has no sort
// parameter.
function mergeBriefNotes(
  createdNotes: GranolaNote[],
  updatedNotes: GranolaNote[],
  cutoff: string,
): GranolaNote[] {
  const cutoffMs = new Date(cutoff).getTime();
  const byId = new Map<string, GranolaNote>();

  for (const note of createdNotes) {
    byId.set(note.id, note);
  }
  for (const note of updatedNotes) {
    if (byId.has(note.id)) {
      continue;
    }
    const createdMs = new Date(note.created_at).getTime();
    byId.set(
      note.id,
      createdMs < cutoffMs ? { ...note, updatedOnly: true } : note,
    );
  }

  return Array.from(byId.values()).sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

async function listNotesForBrief(
  config: ResolvedGranolaConfig,
  createdAfter: string,
  createdBefore: string | null,
  folderId: string | null,
  signal: AbortSignal,
): Promise<GranolaListResponse> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  try {
    const [createdNotes, updatedNotes] = await Promise.all([
      fetchBriefPages(
        config,
        baseUrl,
        "created_after",
        createdAfter,
        createdBefore,
        folderId,
        signal,
      ),
      fetchBriefPages(
        config,
        baseUrl,
        "updated_after",
        createdAfter,
        createdBefore,
        folderId,
        signal,
      ),
    ]);

    const notes = mergeBriefNotes(createdNotes, updatedNotes, createdAfter);
    const parsed = GranolaListResponse({ notes, hasMore: false });
    if (parsed instanceof type.errors) {
      throw new Error("Granola response contains an invalid notes list");
    }
    return parsed;
  } catch (error) {
    if (error instanceof GranolaAuthError) {
      return SKIPPED_LIST_RESULT;
    }
    throw error;
  }
}

async function listNotes(
  config: ResolvedGranolaConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GranolaListResponse> {
  const args = ListNotesArgs(rawArgs);
  if (args instanceof type.errors) {
    throw new Error(`granola_list_notes: ${args.summary}`);
  }

  const heartbeatShaped = isHeartbeatShaped(args);

  if (
    args.enabledSources !== undefined &&
    !args.enabledSources.includes("granola")
  ) {
    return SKIPPED_LIST_RESULT;
  }

  if (config.apiKey.length === 0) {
    throw new Error("Granola apiKey is required");
  }

  const createdAfter = args.createdAfter ?? null;
  const createdBefore = args.createdBefore ?? null;
  const folderId = args.folderId ?? null;

  if (heartbeatShaped && createdAfter !== null) {
    return listNotesForBrief(
      config,
      createdAfter,
      createdBefore,
      folderId,
      signal,
    );
  }

  const limit = optionalPositiveInteger(
    args.limit,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const cursor = args.cursor ?? null;
  const updatedAfter = args.updatedAfter ?? null;

  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/notes`);
  url.searchParams.set("page_size", limit.toString());
  if (cursor !== null) {
    url.searchParams.set("cursor", cursor);
  }
  if (createdAfter !== null) {
    url.searchParams.set("created_after", createdAfter);
  }
  if (createdBefore !== null) {
    url.searchParams.set("created_before", createdBefore);
  }
  if (updatedAfter !== null) {
    url.searchParams.set("updated_after", updatedAfter);
  }
  if (folderId !== null) {
    url.searchParams.set("folder_id", folderId);
  }

  try {
    return parseListResponse(await fetchGranolaJSON(config, url, signal));
  } catch (error) {
    if (heartbeatShaped && error instanceof GranolaAuthError) {
      return SKIPPED_LIST_RESULT;
    }
    throw error;
  }
}

async function listFolders(
  config: ResolvedGranolaConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GranolaFolderListResponse> {
  const args = ListFoldersArgs(rawArgs);
  if (args instanceof type.errors) {
    throw new Error(`granola_list_folders: ${args.summary}`);
  }

  if (config.apiKey.length === 0) {
    throw new Error("Granola apiKey is required");
  }

  const limit = optionalPositiveInteger(
    args.limit,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const cursor = args.cursor ?? null;
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/folders`);
  url.searchParams.set("page_size", limit.toString());
  if (cursor !== null) {
    url.searchParams.set("cursor", cursor);
  }

  return parseFolderListResponse(await fetchGranolaJSON(config, url, signal));
}

async function getNote(
  config: ResolvedGranolaConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GranolaNote> {
  const args = GetNoteArgs(rawArgs);
  if (args instanceof type.errors) {
    // Preserve the back-compat "noteId is required" message when the key is
    // absent; surface the arktype summary for wrong-type inputs (e.g. a number).
    const missing = !("noteId" in rawArgs) || rawArgs.noteId === undefined;
    throw new Error(missing ? "noteId is required" : args.summary);
  }

  if (config.apiKey.length === 0) {
    throw new Error("Granola apiKey is required");
  }

  const url = new URL(
    `${normalizeBaseUrl(config.baseUrl)}/notes/${encodeURIComponent(args.noteId)}`,
  );
  url.searchParams.set("include", "transcript");

  return parseNote(await fetchGranolaJSON(config, url, signal));
}

export const GRANOLA_LIST_NOTES_DEFINITION: ToolDefinition = {
  name: "granola_list_notes",
  description:
    "List recent Granola notes for the configured workbench. Use this to find calls before fetching a full transcript. Brief-shaped calls (enabledSources set with createdAfter) query both created_after and updated_after, paginate up to 5 pages per query at page_size 30, merge by note id sorted by created_at desc, and tag notes created before the cutoff but updated after it with `updatedOnly: true` (a revised earlier meeting, not a new one).",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description:
          "Maximum number of notes to return. Defaults to 10 and caps at 30.",
      },
      cursor: {
        type: "string",
        description:
          "Pagination cursor returned by a prior Granola list response.",
      },
      createdAfter: {
        type: "string",
        description:
          "Return only notes created after this date. ISO date (2026-01-27) or date-time (2026-01-27T15:30:00Z).",
      },
      createdBefore: {
        type: "string",
        description:
          "Return only notes created before this date. ISO date (2026-01-27) or date-time (2026-01-27T15:30:00Z).",
      },
      updatedAfter: {
        type: "string",
        description:
          "Return only notes updated after this date. ISO date (2026-01-27) or date-time (2026-01-27T15:30:00Z).",
      },
      folderId: {
        type: "string",
        description:
          "Return only notes in this folder and its child folders. Use granola_list_folders to discover folder IDs.",
      },
      enabledSources: {
        type: "array",
        items: { type: "string" },
        description:
          'Workbench-internal: the calling member\'s currently-enabled brief source keys. When set and it omits "granola", this call is skipped (returns an empty, `skipped: true` result) instead of hitting the Granola API.',
      },
    },
  },
};

export const GRANOLA_GET_NOTE_DEFINITION: ToolDefinition = {
  name: "granola_get_note",
  description:
    "Fetch a single Granola note, including its transcript, by note ID.",
  inputSchema: {
    type: "object",
    properties: {
      noteId: {
        type: "string",
        description: "Granola note ID to fetch.",
      },
    },
    required: ["noteId"],
  },
};

export const GRANOLA_LIST_FOLDERS_DEFINITION: ToolDefinition = {
  name: "granola_list_folders",
  description:
    "List Granola folders (Spaces) for the configured workbench, sorted alphabetically. Use this to discover folder IDs for filtering notes with granola_list_notes.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description:
          "Maximum number of folders to return. Defaults to 10 and caps at 30.",
      },
      cursor: {
        type: "string",
        description:
          "Pagination cursor returned by a prior Granola folders list response.",
      },
    },
  },
};

export function createGranolaTools(config: GranolaToolsConfig): AgentTool[] {
  const resolved: ResolvedGranolaConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl?.trim() || GRANOLA_DEFAULT_BASE_URL,
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
  };
  validateConfig(resolved);

  return [
    {
      kind: "string",
      definition: GRANOLA_LIST_NOTES_DEFINITION,
      handler: async (args, signal) =>
        jsonResult(await listNotes(resolved, args, signal)),
    },
    {
      kind: "string",
      definition: GRANOLA_GET_NOTE_DEFINITION,
      handler: async (args, signal) =>
        jsonResult(await getNote(resolved, args, signal)),
    },
    {
      kind: "string",
      definition: GRANOLA_LIST_FOLDERS_DEFINITION,
      handler: async (args, signal) =>
        jsonResult(await listFolders(resolved, args, signal)),
    },
  ];
}

/**
 * Hub tool registry entries for granola. Import and spread into the hub's
 * KNOWN_TOOLS to register. No hub logic changes needed when entries are added here.
 */
export const GRANOLA_HUB_TOOLS = {
  granola_list_notes: {
    sideEffect: "read" as const,
    definition: GRANOLA_LIST_NOTES_DEFINITION,
    providerName: "granola" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createGranolaTools({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }),
  },
  granola_get_note: {
    sideEffect: "read" as const,
    definition: GRANOLA_GET_NOTE_DEFINITION,
    providerName: "granola" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createGranolaTools({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }),
  },
  granola_list_folders: {
    sideEffect: "read" as const,
    definition: GRANOLA_LIST_FOLDERS_DEFINITION,
    providerName: "granola" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createGranolaTools({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }),
  },
};

export {
  createGranolaWorkflowTools,
  GRANOLA_WORKFLOW_HUB_TOOLS,
  GRANOLA_NORMALIZE_NOTE_DEFINITION,
  GRANOLA_CLASSIFY_CALL_DEFINITION,
  GRANOLA_PARSE_ANALYSIS_DEFINITION,
  GRANOLA_PREPARE_ARTIFACTS_DEFINITION,
  GRANOLA_EMIT_RUN_OUTPUTS_DEFINITION,
} from "./workflow-tools";

export {
  GRANOLA_SPAWN_CALL_RUNS_DEFINITION,
  GRANOLA_HUB_BACKED_DEFINITIONS,
} from "./hub-tools";
