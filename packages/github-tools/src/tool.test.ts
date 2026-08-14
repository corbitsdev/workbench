import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import { GITHUB_ACTIVITY_TOOL, githubTools } from "./tool";
import type { GitHubEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: GITHUB_ACTIVITY_TOOL,
  arguments: { query: "agent workflows" },
};

/**
 * A fake `credentials` capability mirroring the platform's own
 * `createCredentialCapability`/`createHttpCredentialProvider` shape: a
 * bound `secret` resolves to a mediated `fetch` that injects a bearer
 * header and delegates to `globalThis.fetch`; an unbound handle throws,
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
          headers.set("authorization", `Bearer ${secret}`);
          return fetch(input as string | URL, { ...init, headers });
        },
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): GitHubEnv {
  return { credentials } as unknown as GitHubEnv;
}

function emptyResponsesFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
    })) as unknown as typeof fetch;
}

test("declares the github_activity tool", () => {
  const bundle = githubTools(fakeEnv(undefined));
  expect(bundle.definitions.map((d) => d.name)).toEqual([GITHUB_ACTIVITY_TOOL]);
});

test("rejects a missing query without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(undefined));
    const result = await bundle.run(
      { id: "call_2", name: GITHUB_ACTIVITY_TOOL, arguments: {} },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("works with no credentials capability at all (keyless call succeeds, not an error)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyResponsesFetch();
  try {
    const bundle = githubTools(fakeEnv(undefined));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      items: unknown[];
    };
    expect(parsed.items).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an unauthenticated call (not an error) when resolve() throws", async () => {
  const originalFetch = globalThis.fetch;
  const capturedHeaders: (Headers | undefined)[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedHeaders.push(init?.headers as Headers | undefined);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(fakeCredentials(undefined)));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    for (const headers of capturedHeaders) {
      expect(headers?.get?.("authorization")).toBeFalsy();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the mediated fetch (authenticated) when a credential resolves", async () => {
  const originalFetch = globalThis.fetch;
  const capturedHeaders: (Headers | undefined)[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedHeaders.push(init?.headers as Headers | undefined);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(fakeCredentials("ghp_test")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(capturedHeaders.length).toBeGreaterThan(0);
    for (const headers of capturedHeaders) {
      expect(headers?.get?.("authorization")).toBe("Bearer ghp_test");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 403 })) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(undefined));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result the same way with a credential resolving", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(fakeCredentials("ghp_test")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
