// Fallback message names what was happening, never the raw route, which
// nobody reading a settings panel should have to see. Each seam keeps its
// own `ApiQueryError` subclass so a catch site can tell which API failed
// while `QueryClient` retry/auth-invalidation rules still see status codes.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

import { ApiQueryError, UnauthenticatedError } from "@/lib/api-query";

const CardinalErrorEnvelope = type({
  error: { code: "string", userMessage: "string", "refId?": "string" },
});

const StockErrorEnvelope = type({
  error: { code: "string", message: "string" },
});

// The hub's own envelope `userMessage` (or stock `message`) wins when
// present, otherwise a generic, path-free sentence.
export function readErrorEnvelope(status: number, body: unknown, verb?: string): string {
  const cardinal = CardinalErrorEnvelope(body);
  if (!(cardinal instanceof type.errors)) {
    return cardinal.error.userMessage;
  }
  const stock = StockErrorEnvelope(body);
  if (!(stock instanceof type.errors)) {
    return stock.error.message;
  }
  return verb !== undefined && verb.length > 0
    ? `The server answered ${status} while ${verb}.`
    : `The server answered ${status}.`;
}

export type Validator<T> = (data: unknown) => T | ArkErrors;

export type ApiErrorCtor = new (message: string, status?: number, path?: string) => Error;

// Exported (not `typeof fetch`) so a bound server-side wrapper — which never
// carries `fetch`'s static `preconnect` member — satisfies the type too.
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ApiRequestOptions = {
  readonly verb?: string;
  readonly ErrorCtor?: ApiErrorCtor;
  readonly init?: RequestInit;
  readonly fetchImpl?: FetchImpl;
  readonly throwUnauthenticatedOn401?: boolean;
};

function defaultHeaders(init?: RequestInit): HeadersInit {
  const hasBody = init?.body !== undefined;
  return {
    accept: "application/json",
    ...(hasBody || init?.method !== undefined ? { "content-type": "application/json" } : {}),
    ...init?.headers,
  };
}

export async function apiRequest<T>(
  path: string,
  schema: Validator<T>,
  verb?: string,
  ErrorCtor: ApiErrorCtor = ApiQueryError,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch,
  options?: { readonly throwUnauthenticatedOn401?: boolean },
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      headers: defaultHeaders(init),
    });
  } catch (cause) {
    throw new ErrorCtor(cause instanceof Error ? cause.message : String(cause), undefined, path);
  }
  if (response.status === 401 && options?.throwUnauthenticatedOn401 === true) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ErrorCtor(readErrorEnvelope(response.status, body, verb), response.status, path);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    const prefix =
      verb !== undefined && verb.length > 0
        ? `Unexpected response shape while ${verb}`
        : "Unexpected response shape";
    throw new ErrorCtor(`${prefix}: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

/** For a route whose success response is `204 No Content` — nothing to
 * validate against a schema, so this is the one place a call is allowed
 * to end without a parsed body, rather than every `request<T>` caller
 * having to accept an unsound `undefined as T`. */
export async function requestVoid(
  path: string,
  verb?: string,
  ErrorCtor: ApiErrorCtor = ApiQueryError,
  init?: RequestInit,
  fetchImpl: FetchImpl = fetch,
  options?: { readonly throwUnauthenticatedOn401?: boolean },
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ErrorCtor(cause instanceof Error ? cause.message : String(cause), undefined, path);
  }
  if (response.status === 401 && options?.throwUnauthenticatedOn401 === true) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new ErrorCtor(readErrorEnvelope(response.status, body, verb), response.status, path);
  }
  // A void route answers `204 No Content` by contract. Any other 2xx (e.g.
  // a 200/201-with-body a route drifted into returning where 204 is expected)
  // is a contract mismatch and must fail loudly rather than be silently
  // accepted as an empty success.
  if (response.status !== 204) {
    const label = verb !== undefined && verb.length > 0 ? `while ${verb}` : `for ${path}`;
    throw new ErrorCtor(
      `Unexpected response ${label}: expected 204 No Content, got ${response.status}`,
      response.status,
      path,
    );
  }
}
