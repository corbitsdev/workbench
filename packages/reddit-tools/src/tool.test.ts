import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import {
  REDDIT_SEARCH_TOOL,
  REDDIT_SUBREDDIT_SEARCH_TOOL,
  redditTools,
} from "./tool";
import type { RedditEnv } from "./tool";

const SEARCH_CALL: ToolCall = {
  id: "call_1",
  name: REDDIT_SEARCH_TOOL,
  arguments: { query: "onboarding pain" },
};

const SUBREDDIT_SEARCH_CALL: ToolCall = {
  id: "call_2",
  name: REDDIT_SUBREDDIT_SEARCH_TOOL,
  arguments: { subreddit: "startups", query: "onboarding pain" },
};

/**
 * A fake `credentials` capability mirroring the platform's own
 * `createCredentialCapability`/`createHttpCredentialProvider` shape: a
 * bound `secret` resolves to a mediated `fetch` that injects a header
 * and delegates to `globalThis.fetch`; an unbound handle throws,
 * matching the real gate's "no credential is bound to handle" failure.
 */
function fakeCredentials(secret: string | undefined): CredentialCapability {
  return {
    resolve(handle: string): Promise<MediatedCredential> {
      if (secret === undefined) {
        return Promise.reject(
          new Error(`no credential is bound to handle "${handle}"`),
        );
      }
      return Promise.resolve({
        kind: "http",
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("x-api-key", secret);
          return fetch(input as string | URL, { ...init, headers });
        },
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): RedditEnv {
  return { credentials } as unknown as RedditEnv;
}

test("declares both reddit tools", () => {
  const bundle = redditTools(fakeEnv(fakeCredentials("key")));
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    REDDIT_SEARCH_TOOL,
    REDDIT_SUBREDDIT_SEARCH_TOOL,
  ]);
});

test("degrades to a non-throwing 'not connected' error when no credential is bound", async () => {
  const bundle = redditTools(fakeEnv(fakeCredentials(undefined)));
  const result = await bundle.run(SEARCH_CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way when the step carries no credentials capability at all", async () => {
  const bundle = redditTools(fakeEnv(undefined));
  const result = await bundle.run(
    SUBREDDIT_SEARCH_CALL,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("rejects a search call with no query, without throwing", async () => {
  const bundle = redditTools(fakeEnv(fakeCredentials("key")));
  const result = await bundle.run(
    { id: "call_3", name: REDDIT_SEARCH_TOOL, arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("requires a non-empty query");
});

test("rejects a subreddit search call with no subreddit, without throwing", async () => {
  const bundle = redditTools(fakeEnv(fakeCredentials("key")));
  const result = await bundle.run(
    {
      id: "call_4",
      name: REDDIT_SUBREDDIT_SEARCH_TOOL,
      arguments: { query: "onboarding" },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("requires non-empty subreddit and query");
});

test("returns posts as JSON content on a successful search call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    expect((init?.headers as Headers | undefined)?.get("x-api-key")).toBe(
      "key",
    );
    return new Response(
      JSON.stringify({
        posts: [
          {
            title: "Onboarding takes forever",
            url: "https://reddit.com/r/startups/comments/xyz/onboarding",
            permalink: "/r/startups/comments/xyz/onboarding",
            subreddit: "startups",
            created_at: "2026-08-01T00:00:00.000Z",
            ups: 5,
            num_comments: 2,
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = redditTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(SEARCH_CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({
      posts: [
        {
          title: "Onboarding takes forever",
          url: "https://reddit.com/r/startups/comments/xyz/onboarding",
          permalink: "/r/startups/comments/xyz/onboarding",
          subreddit: "startups",
          createdAt: "2026-08-01T00:00:00.000Z",
          upvotes: 5,
          numComments: 2,
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = redditTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      SUBREDDIT_SEARCH_CALL,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
