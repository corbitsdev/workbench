// Neither this file nor `QueryView` imports `@tanstack/react-query`, so a
// host wires its own query hook to this contract instead of one being
// assumed.

export type APIQuery<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly retry: () => void;
      // Lets a caller tell "404, not found" from "500, broken" instead of
      // one generic error state.
      readonly status?: number;
    }
  | { readonly kind: "ready"; readonly data: T };

// Thrown on HTTP 401 so a retry policy can stop retrying and `toAPIQuery`
// can map it to `kind: "unauthenticated"`.
export class UnauthenticatedError extends Error {
  constructor(message = "unauthenticated") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

// `path` is for logs only, never surfaced in user-facing copy.
export class ApiQueryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
    readonly refId?: string,
  ) {
    super(message);
  }
}

// Technical detail stays in console/devtools, never the primary line a
// person reads.
export function describeQueryError(error: unknown): string {
  if (error instanceof TypeError) {
    return "Can't reach the server. Check your connection.";
  }
  return "Something went wrong. Try again.";
}

// Reads only `error.status`, never `error.message`, so a request path or
// raw status text baked into a thrown message can never leak through.
export function describeApiError(error: unknown, doing: string): string {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  if (status === 401 || status === 403) {
    return "You don't have access to this.";
  }
  if (status === 404) {
    return "This isn't here anymore.";
  }
  return `Something went wrong ${doing}. Try again.`;
}

// `isLoading` (pending + fetching), not bare `isPending`, since the
// latter would flash skeletons when cached data exists.
export function toAPIQuery<T>(result: {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: T | undefined;
  readonly isPending: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  readonly refetch: () => void;
}): APIQuery<T> {
  if (result.isLoading) return { kind: "loading" };
  if (result.isError) {
    if (result.error instanceof UnauthenticatedError) {
      return { kind: "unauthenticated" };
    }
    if (result.error instanceof ApiQueryError && result.error.status !== undefined) {
      return {
        kind: "error",
        message: describeQueryError(result.error),
        retry: result.refetch,
        status: result.error.status,
      };
    }
    return {
      kind: "error",
      message: describeQueryError(result.error),
      retry: result.refetch,
    };
  }
  if (result.data !== undefined) return { kind: "ready", data: result.data };
  // Disabled queries (empty path, unresolved tenant) have no data and are not
  // fetching — still report loading so callers that gate on "ready" stay quiet.
  return { kind: "loading" };
}
