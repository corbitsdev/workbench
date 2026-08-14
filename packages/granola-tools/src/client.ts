// A minimal Granola API client: one call, one shape. Callers that need
// more (transcripts, folders, write access) extend this module rather
// than reach around it — every workbench consumer of Granola notes goes
// through the same parsed, validated shape.
import { type } from "arktype";

const GranolaTranscriptLine = type({
  speaker: "string",
  text: "string",
});
export type GranolaTranscriptLine = typeof GranolaTranscriptLine.infer;

export const GranolaNote = type({
  id: "string",
  title: "string",
  "summary?": "string",
  createdAt: "string",
  /** Only populated when fetched with `getGranolaNote`. */
  "transcript?": GranolaTranscriptLine.array(),
});
export type GranolaNote = typeof GranolaNote.infer;

const GranolaListNotesResponse = type({ notes: GranolaNote.array() });

export interface GranolaClientConfig {
  readonly apiKey: string;
  /** Override for tests; defaults to the real Granola API host. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.granola.ai";

/**
 * Lists the caller's recent Granola call notes, newest first. Throws on
 * any transport, HTTP, or shape failure — callers that need graceful
 * degradation (e.g. the morning-brief tool) catch at their own
 * boundary rather than this client silently swallowing errors.
 */
export async function listRecentGranolaNotes(
  config: GranolaClientConfig,
  params: { readonly since?: string } = {},
): Promise<readonly GranolaNote[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const url = new URL("/v1/notes", config.baseUrl ?? DEFAULT_BASE_URL);
  if (params.since !== undefined) {
    url.searchParams.set("since", params.since);
  }
  const response = await doFetch(url, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `Granola list-notes request failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = GranolaListNotesResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Granola list-notes response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.notes;
}

/**
 * Fetches one Granola call note by id, with its transcript. Throws on
 * any transport, HTTP, or shape failure, same as
 * {@link listRecentGranolaNotes} — callers that need graceful
 * degradation catch at their own boundary.
 */
export async function getGranolaNote(
  config: GranolaClientConfig,
  params: { readonly noteId: string },
): Promise<GranolaNote> {
  const doFetch = config.fetchImpl ?? fetch;
  const url = new URL(
    `/v1/notes/${encodeURIComponent(params.noteId)}`,
    config.baseUrl ?? DEFAULT_BASE_URL,
  );
  url.searchParams.set("include", "transcript");
  const response = await doFetch(url, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `Granola get-note request failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = GranolaNote(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Granola get-note response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}
