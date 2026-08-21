import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import { GIF_SEARCH_TOOL, gifSearchTool } from "./gif-search-tool";
import type { GifSearchEnv } from "./gif-search-tool";

const CALL: ToolCall = {
  id: "call_1",
  name: GIF_SEARCH_TOOL,
  arguments: { query: "throw a party" },
};

/**
 * Fake `credentials` capability, mirroring `@corbits/web-search-tools`'
 * `tool.test.ts`: a bound secret resolves to a mediated fetch that
 * delegates to `globalThis.fetch`; an unbound handle rejects the same way
 * the real gate does when no credential is bound.
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
        fetch: (input, init) => fetch(input as string | URL, init),
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): GifSearchEnv {
  return { credentials } as unknown as GifSearchEnv;
}

const GIPHY_RESPONSE = {
  data: [
    {
      title: "party gif",
      url: "https://giphy.com/gifs/party-abc123",
      images: {
        original: { url: "https://media.giphy.com/media/abc123/giphy.gif" },
      },
    },
  ],
  meta: { status: 200, msg: "OK" },
};

test("declares the gif_search tool", () => {
  const bundle = gifSearchTool(fakeEnv(fakeCredentials("key")));
  expect(bundle.definitions.map((d) => d.name)).toEqual([GIF_SEARCH_TOOL]);
});

test("returns a gif CDN url for a stubbed Giphy search", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(GIPHY_RESPONSE), {
      status: 200,
    })) as unknown as typeof fetch;
  try {
    const bundle = gifSearchTool(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(
      "https://media.giphy.com/media/abc123/giphy.gif",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces a connect prompt, never a silent no-op, when Giphy is not connected", async () => {
  const bundle = gifSearchTool(fakeEnv(fakeCredentials(undefined)));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/connect giphy/i);
});

test("surfaces the same connect prompt when the step carries no credentials capability at all", async () => {
  const bundle = gifSearchTool(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/connect giphy/i);
});

test("rejects a missing query without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = gifSearchTool(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      { id: "call_2", name: GIF_SEARCH_TOOL, arguments: {} },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when Giphy rejects the key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;
  try {
    const bundle = gifSearchTool(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
