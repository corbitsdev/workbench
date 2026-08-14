// A minimal Granola API client: one call, one shape. Callers that need
// more (transcripts, folders, write access) extend this module rather
// than reach around it — every workbench consumer of Granola notes goes
// through the same parsed, validated shape.
import { type } from "arktype";

export const GranolaNote = type({
  id: "string",
  title: "string",
  "summary?": "string",
  createdAt: "string",
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
