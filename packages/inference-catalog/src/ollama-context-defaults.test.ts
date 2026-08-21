import { describe, expect, test } from "bun:test";
import { createOllamaAdapter } from "@corbits/ollama-adapter";
import type { LastCycleSource } from "@intx/types/runtime";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";

import {
  OLLAMA_MODEL_DEFAULTS,
  quirksForDeployment,
} from "./ollama-context-defaults";

describe("quirksForDeployment", () => {
  test("a curated Ollama model resolves its advertised native context window", () => {
    const quirks = quirksForDeployment({
      providerName: "ollama",
      canonicalName: "gpt-oss:20b",
    });
    const gptOssDefault = OLLAMA_MODEL_DEFAULTS["gpt-oss:20b"];
    if (gptOssDefault === undefined) throw new Error("missing fixture entry");
    expect(quirks).toEqual({ default: gptOssDefault });
    expect(quirks?.default?.numCtx).toBeGreaterThanOrEqual(131_072);
  });

  test("a model with a smaller real ceiling gets its own limit, not the larger model's", () => {
    const bigModel = quirksForDeployment({
      providerName: "ollama",
      canonicalName: "llama3.1:8b",
    });
    const smallerModel = quirksForDeployment({
      providerName: "ollama",
      canonicalName: "qwen3.8:27b",
    });
    expect(bigModel?.default?.numCtx).toBe(131_072);
    expect(smallerModel?.default?.numCtx).toBe(32_768);
    expect(smallerModel?.default?.numCtx).toBeLessThan(
      bigModel?.default?.numCtx ?? 0,
    );
  });

  test("a caller-supplied override wins over the built-in table", () => {
    const quirks = quirksForDeployment(
      { providerName: "ollama", canonicalName: "gpt-oss:20b" },
      { "gpt-oss:20b": { numCtx: 8192 } },
    );
    expect(quirks).toEqual({ default: { numCtx: 8192 } });
  });

  test("a model absent from the table gets no override, never a guessed number", () => {
    const quirks = quirksForDeployment({
      providerName: "ollama",
      canonicalName: "some-future-model:1b",
    });
    expect(quirks).toBeUndefined();
  });

  test("a non-Ollama provider is left untouched even on the same openai-compatible wire", () => {
    const quirks = quirksForDeployment({
      providerName: "groq",
      canonicalName: "gpt-oss:20b",
    });
    expect(quirks).toBeUndefined();
  });
});

describe("the resolved quirks reach the built Ollama request body", () => {
  const source: LastCycleSource = {
    sourceId: "ollama-test",
    provider: "ollama",
    model: "gpt-oss:20b",
  };
  const messages: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
  ];
  const options: InferenceOptions = {};

  test("gpt-oss:20b's request carries its 128K context window, not the built-in 4096 default", () => {
    const quirks = quirksForDeployment({
      providerName: "ollama",
      canonicalName: "gpt-oss:20b",
    });
    const adapter = createOllamaAdapter(source, quirks);
    const built = adapter.buildRequest(messages, "gpt-oss:20b", options);
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(body["options"]).toEqual({ num_ctx: 131_072 });
    expect(body["max_tokens"]).toBe(32_768);
    expect(body["max_tokens"]).not.toBe(4096);
  });

  test("qwen3.8:27b's request carries its own smaller real ceiling", () => {
    const quirks = quirksForDeployment({
      providerName: "ollama",
      canonicalName: "qwen3.8:27b",
    });
    const adapter = createOllamaAdapter(source, quirks);
    const built = adapter.buildRequest(messages, "qwen3.8:27b", options);
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(body["options"]).toEqual({ num_ctx: 32_768 });
  });
});
