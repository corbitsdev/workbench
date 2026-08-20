import { describe, expect, test } from "bun:test";
import {
  isEmbeddingModelName,
  preferCompletionCapable,
} from "./model-capability";

describe("isEmbeddingModelName", () => {
  test("recognizes common embedding model families", () => {
    expect(isEmbeddingModelName("all-minilm")).toBe(true);
    expect(isEmbeddingModelName("all-minilm:33m")).toBe(true);
    expect(isEmbeddingModelName("nomic-embed-text")).toBe(true);
    expect(isEmbeddingModelName("mxbai-embed-large")).toBe(true);
    expect(isEmbeddingModelName("bge-m3")).toBe(true);
    expect(isEmbeddingModelName("snowflake-arctic-embed")).toBe(true);
  });

  test("leaves completion model names alone", () => {
    expect(isEmbeddingModelName("qwen3:8b")).toBe(false);
    expect(isEmbeddingModelName("llama3.1:70b")).toBe(false);
    expect(isEmbeddingModelName("gpt-4o")).toBe(false);
    expect(isEmbeddingModelName("claude-sonnet-4-5")).toBe(false);
  });
});

describe("preferCompletionCapable", () => {
  test("drops embedding-named offerings when a completion offering exists", () => {
    const offerings = ["all-minilm", "qwen3:8b", "nomic-embed-text"];
    expect(preferCompletionCapable(offerings, (name) => name)).toEqual([
      "qwen3:8b",
    ]);
  });

  test("keeps every offering when none are recognized as embedding models", () => {
    const offerings = ["gpt-4o", "claude-sonnet-4-5"];
    expect(preferCompletionCapable(offerings, (name) => name)).toEqual(
      offerings,
    );
  });

  test("falls back to the unfiltered list when every offering looks like an embedding model", () => {
    const offerings = ["all-minilm", "nomic-embed-text"];
    expect(preferCompletionCapable(offerings, (name) => name)).toEqual(
      offerings,
    );
  });
});
