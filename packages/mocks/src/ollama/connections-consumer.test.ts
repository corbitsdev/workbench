// Wires the mock into the REAL call sites it exists to plug into —
// `@corbits/connections`'s `FetchLike`-shaped functions — rather than
// calling `mock.fetch` directly the way `mock.test.ts` does. That
// distinction matters: `mock.fetch(new Request(...))` typechecking says
// nothing about whether the mock satisfies the two-argument
// `(url, init) => Promise<Response>` shape every real caller
// (`testProviderCredential`, `fetchOllamaModelCatalog`,
// `fetchOllamaModelCapabilities`) actually uses. A cast past a signature
// mismatch here would compile and then silently return `undefined` at
// runtime, since these functions swallow thrown errors as "unreachable" —
// exactly the failure mode a reviewer using this package as a real
// consumer hit.
import { describe, expect, test } from "bun:test";
import {
  fetchOllamaModelCatalog,
  testProviderCredential,
  OLLAMA_PLACEHOLDER_SECRET,
} from "@corbits/connections/credential-test";
import { preferCompletionCapable } from "@corbits/connections/model-capability";
import { createOllamaMock } from "./index";

const BASE_URL = "http://mock-ollama";

describe("OllamaMock as a real connections FetchLike consumer", () => {
  test("testProviderCredential proves reachability through the mock with no cast", async () => {
    const ollama = createOllamaMock({ models: [{ name: "qwen3.8:27b" }] });

    const result = await testProviderCredential({
      provider: "ollama",
      apiKey: OLLAMA_PLACEHOLDER_SECRET,
      baseURL: BASE_URL,
      fetchImpl: ollama.fetch,
    });

    expect(result).toEqual({ ok: true });
  });

  // The CL-6477 scenario: a fresh Ollama connect whose only pulled model
  // sorts first alphabetically is an embedding model. Without real,
  // wire-observed capability data, default-model resolution
  // (`preferCompletionCapable`) has nothing to filter on and an embedding
  // model wins the chat default. `fetchOllamaModelCatalog` probes each
  // model's capabilities (`/api/show`) the same way a live instance would.
  test("fetchOllamaModelCatalog + preferCompletionCapable never let embeddinggemma win the chat default", async () => {
    const ollama = createOllamaMock({
      models: [
        { name: "embeddinggemma:300m", capabilities: ["embedding"] },
        { name: "qwen3.8:27b", capabilities: ["completion", "tools"] },
      ],
    });

    const catalog = await fetchOllamaModelCatalog(BASE_URL, ollama.fetch);
    expect(catalog).toBeDefined();
    expect(catalog?.map((m) => m.canonicalName)).toEqual([
      "embeddinggemma:300m",
      "qwen3.8:27b",
    ]);

    const chatCapable = preferCompletionCapable(
      catalog ?? [],
      (model) => model.capabilities,
      (model) => model.canonicalName,
    );

    expect(chatCapable.map((m) => m.canonicalName)).toEqual(["qwen3.8:27b"]);
  });
});
