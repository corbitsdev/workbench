// fetchOllamaTags: validates the base URL actually reaches Ollama and
// parses its native /api/tags shape, on the bare origin (not /v1).

import { afterEach, describe, expect, test } from "bun:test";

import { fetchOllamaTags, OllamaTagsError, ollamaOrigin } from "./ollama-tags";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ollamaOrigin", () => {
  test("strips a trailing /v1 used for chat completions", () => {
    expect(ollamaOrigin("http://localhost:11434/v1")).toBe("http://localhost:11434");
  });
  test("leaves a bare origin alone", () => {
    expect(ollamaOrigin("http://localhost:11434")).toBe("http://localhost:11434");
  });
});

describe("fetchOllamaTags", () => {
  test("hits /api/tags on the bare origin and returns model names", async () => {
    let requested = "";
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested = String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: "qwen2.5:14b" }, { name: "llama3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const tags = await fetchOllamaTags("http://localhost:11434/v1");
    expect(requested).toBe("http://localhost:11434/api/tags");
    expect(tags).toEqual(["qwen2.5:14b", "llama3"]);
  });

  test("rejects with a clear message when the server isn't Ollama", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      void input;
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;
    await expect(fetchOllamaTags("http://localhost:11434/v1")).rejects.toBeInstanceOf(
      OllamaTagsError,
    );
  });

  test("rejects when the response shape doesn't match", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    await expect(fetchOllamaTags("http://localhost:11434/v1")).rejects.toBeInstanceOf(
      OllamaTagsError,
    );
  });
});
