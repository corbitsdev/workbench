// Typed client for the two `@corbits/mailbox` thread-read routes
// (`GET /me/threads`, `GET /me/threads/:rootMessageId`), mounted by
// `apps/hub` under `${TENANT_PREFIX}/mailbox` (see apps/hub/src/index.ts).
// Fetch composition only — the wire schemas and result types are
// `@corbits/mailbox`'s own, reused rather than redeclared so this checkout
// and the pinned mailbox version can never silently drift apart.
//
// `@corbits/mailbox` is an external git dependency, so importing it here
// (even its runtime arktype schemas) is not a browser-safe-subpath
// violation: the check treats an unowned package as an opaque leaf.

import { type } from "arktype";
import {
  MailboxThreadListResponseSchema,
  MailboxThreadResponseSchema,
  type MailboxRef,
} from "@corbits/mailbox";

export class MailboxThreadFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = "MailboxThreadFetchError";
  }
}

export type MailboxThreadListResult = typeof MailboxThreadListResponseSchema.infer;

export type MailboxThreadResult = typeof MailboxThreadResponseSchema.infer;

async function requestMailboxThreadJSON<T>(
  path: string,
  schema: (data: unknown) => T | type.errors,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new MailboxThreadFetchError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : "",
      )
      .catch(() => "");
    throw new MailboxThreadFetchError(
      detail === "" ? `the server answered ${response.status}` : detail,
      response.status,
      path,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new MailboxThreadFetchError(
      `unexpected response shape from ${path}: ${parsed.summary}`,
      response.status,
      path,
    );
  }
  return parsed;
}

/**
 * List the caller's conversations, newest activity first. `refs` (optional)
 * is JSON-encoded the same way the route documents — an array of
 * `{kind, id}` pairs OR'd together to scope the listing.
 */
export function listMailboxThreadsClient(
  mailboxBasePath: string,
  args: { refs?: MailboxRef[]; cursor?: string; limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<MailboxThreadListResult> {
  const params = new URLSearchParams();
  if (args.refs !== undefined) params.set("refs", JSON.stringify(args.refs));
  if (args.cursor !== undefined) params.set("cursor", args.cursor);
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  const query = params.toString();
  const path = `${mailboxBasePath}/me/threads${query === "" ? "" : `?${query}`}`;
  return requestMailboxThreadJSON(path, MailboxThreadListResponseSchema, fetchImpl);
}

/**
 * Read one conversation by its root Message-ID, oldest message first.
 */
export function readMailboxThreadClient(
  mailboxBasePath: string,
  rootMessageId: string,
  args: { cursor?: string; limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<MailboxThreadResult> {
  const params = new URLSearchParams();
  if (args.cursor !== undefined) params.set("cursor", args.cursor);
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  const query = params.toString();
  const path = `${mailboxBasePath}/me/threads/${encodeURIComponent(rootMessageId)}${
    query === "" ? "" : `?${query}`
  }`;
  return requestMailboxThreadJSON(path, MailboxThreadResponseSchema, fetchImpl);
}
