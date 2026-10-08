// Fallback message names what was happening, never the raw route, which
// nobody reading a settings panel should have to see. Each seam keeps its
// own `Error` subclass so a catch site can tell which API failed.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

const ErrorEnvelope = type({
  error: { code: "string", userMessage: "string", refId: "string" },
});

// The hub's own envelope `userMessage` wins when present, otherwise a
// generic, path-free sentence.
export function readErrorEnvelope(status: number, body: unknown, verb: string): string {
  const envelope = ErrorEnvelope(body);
  return envelope instanceof type.errors
    ? `The server answered ${status} while ${verb}.`
    : envelope.error.userMessage;
}

export type Validator<T> = (data: unknown) => T | ArkErrors;

export type ApiErrorCtor = new (message: string, status?: number) => Error;

export async function apiRequest<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  ErrorCtor: ApiErrorCtor,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ErrorCtor(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ErrorCtor(readErrorEnvelope(response.status, body, verb), response.status);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ErrorCtor(`Unexpected response shape while ${verb}: ${parsed.summary}`);
  }
  return parsed;
}

/** For a route whose success response is `204 No Content` — nothing to
 * validate against a schema, so this is the one place a call is allowed
 * to end without a parsed body, rather than every `request<T>` caller
 * having to accept an unsound `undefined as T`. */
export async function requestVoid(
  path: string,
  verb: string,
  ErrorCtor: ApiErrorCtor,
  init?: RequestInit,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ErrorCtor(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ErrorCtor(readErrorEnvelope(response.status, body, verb), response.status);
  }
  // A void route answers `204 No Content` by contract. Any other 2xx (e.g.
  // a 200/201-with-body a route drifted into returning where 204 is expected)
  // is a contract mismatch and must fail loudly rather than be silently
  // accepted as an empty success.
  if (response.status !== 204) {
    throw new ErrorCtor(
      `Unexpected response while ${verb}: expected 204 No Content, got ${response.status}`,
      response.status,
    );
  }
}
