// Shared fetch+parse wrapper for every settings-ui API seam
// (credentials-api.ts, connections-api.ts, access-policy-api.ts,
// granola-webhook-api.ts): the same envelope-first error message on every
// non-2xx response, matching `apps/web/src/onboarding.ts`'s
// `readErrorEnvelope` — the hub's own `{error:{message}}` body wins when
// present, and the fallback names what was happening ("while loading
// credentials") rather than the raw route, which nobody reading a settings
// panel should ever have to see. Each seam keeps its own `Error` subclass
// so a catch site can still tell which API failed; only the request shape
// is shared here.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

const ErrorEnvelope = type({
  error: { message: "string", "code?": "string" },
});

/**
 * Resolves a non-2xx response's message: the hub's own envelope message
 * when the body carries one, otherwise a generic, path-free sentence
 * naming the status and what the caller was doing.
 */
export function readErrorEnvelope(
  status: number,
  body: unknown,
  verb: string,
): string {
  const envelope = ErrorEnvelope(body);
  return envelope instanceof type.errors
    ? `The server answered ${status} while ${verb}.`
    : envelope.error.message;
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
    throw new ErrorCtor(
      readErrorEnvelope(response.status, body, verb),
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ErrorCtor(
      `Unexpected response shape while ${verb}: ${parsed.summary}`,
    );
  }
  return parsed;
}
