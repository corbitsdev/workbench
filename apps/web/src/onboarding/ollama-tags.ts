// Validates a local Ollama connect against the server the user actually
// typed in, from the browser — the hub never sees this request. `GET
// /api/tags` is Ollama's own native listing route, served on the plain
// base origin even though the chat-completions base URL a caller stores
// carries a trailing `/v1`.

import { type } from "arktype";

export class OllamaTagsError extends Error {}

const TagsResponse = type({ models: type({ name: "string" }).array() });

/** Ollama's native routes (`/api/tags`) live on the bare origin; the
 * OpenAI-compatible chat routes this app stores as the offering's base URL
 * live under `/v1` on that same origin. */
export function ollamaOrigin(baseURL: string): string {
  return baseURL
    .trim()
    .replace(/\/v1\/?$/, "")
    .replace(/\/+$/, "");
}

/** The tags this Ollama server currently has pulled, straight from the
 * browser. Throws `OllamaTagsError` with a message safe to show as-is. */
export async function fetchOllamaTags(baseURL: string): Promise<readonly string[]> {
  const origin = ollamaOrigin(baseURL);
  if (origin === "") {
    throw new OllamaTagsError("Enter a base URL first.");
  }
  let response: Response;
  try {
    response = await fetch(`${origin}/api/tags`, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new OllamaTagsError(
      `Couldn't reach Ollama at ${origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new OllamaTagsError(
      `Ollama at ${origin} answered ${String(response.status)} for /api/tags.`,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = TagsResponse(body);
  if (parsed instanceof type.errors) {
    throw new OllamaTagsError(`Unexpected response shape from ${origin}/api/tags.`);
  }
  return parsed.models.map((model) => model.name);
}
