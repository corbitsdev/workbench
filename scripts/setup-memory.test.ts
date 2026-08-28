import { describe, expect, test } from "bun:test";
import {
  applyEnvKeysToDotenvContents,
  dotenvHasActiveKey,
  localDevMemoryEmbedEnv,
  planEmbedding,
  planRerank,
} from "./setup-memory";

describe("planEmbedding", () => {
  test("recommends native Ollama first when it's on PATH", () => {
    const plan = planEmbedding({ hasNativeOllama: true, hasDocker: true });
    expect(plan.strategy).toBe("native-ollama");
    expect(plan.env["EMBED_BASE_URL"]).toBe("http://localhost:11434");
    expect(plan.env["EMBED_API_STYLE"]).toBe("ollama");
  });

  test("falls back to a Dockerized Ollama when native isn't available but Docker is", () => {
    const plan = planEmbedding({ hasNativeOllama: false, hasDocker: true });
    expect(plan.strategy).toBe("docker-ollama");
    expect(plan.env["EMBED_API_STYLE"]).toBe("ollama");
  });

  test("recommends a remote endpoint when neither native Ollama nor Docker is available", () => {
    const plan = planEmbedding({ hasNativeOllama: false, hasDocker: false });
    expect(plan.strategy).toBe("endpoint");
    expect(plan.env).toEqual({});
    expect(plan.instructions.join("\n")).toMatch(/EMBED_BASE_URL/);
  });
});

describe("planRerank", () => {
  test("recommends the Dockerized TEI reranker when Docker is available", () => {
    const plan = planRerank({ hasNativeOllama: true, hasDocker: true });
    expect(plan.strategy).toBe("docker-tei");
    expect(plan.env["RERANK_BASE_URL"]).toBe("http://localhost:8081");
    expect(plan.env["RERANK_MODEL"]).toBe("BAAI/bge-reranker-base");
  });

  test("recommends a remote endpoint when Docker is unavailable, never a native path", () => {
    const plan = planRerank({ hasNativeOllama: true, hasDocker: false });
    expect(plan.strategy).toBe("endpoint");
    expect(plan.env).toEqual({});
    expect(plan.instructions.join("\n")).toMatch(/RERANK_BASE_URL/);
  });

  test("is explicit that skipping reranking still leaves search working", () => {
    const plan = planRerank({ hasNativeOllama: false, hasDocker: false });
    expect(plan.instructions.join("\n")).toMatch(/search still works/i);
  });
});

describe("localDevMemoryEmbedEnv", () => {
  test("injects native Ollama embed env when nothing is configured and ollama is on PATH", () => {
    expect(localDevMemoryEmbedEnv({}, { hasNativeOllama: true })).toEqual({
      EMBED_BASE_URL: "http://localhost:11434",
      EMBED_MODEL: "nomic-embed-text",
      EMBED_API_STYLE: "ollama",
    });
  });

  test("does not inject when EMBED_BASE_URL is already set", () => {
    expect(
      localDevMemoryEmbedEnv(
        { EMBED_BASE_URL: "https://api.openai.com/v1" },
        { hasNativeOllama: true },
      ),
    ).toBeUndefined();
  });

  test("does not inject when OLLAMA_BASE_URL is already set — mountMemory uses it", () => {
    expect(
      localDevMemoryEmbedEnv(
        { OLLAMA_BASE_URL: "http://localhost:11434" },
        { hasNativeOllama: true },
      ),
    ).toBeUndefined();
  });

  test("does not inject when native Ollama is absent", () => {
    expect(
      localDevMemoryEmbedEnv({}, { hasNativeOllama: false }),
    ).toBeUndefined();
  });
});

describe("applyEnvKeysToDotenvContents", () => {
  test("appends missing keys and ignores commented-out lines", () => {
    const existing =
      "# EMBED_BASE_URL=http://example\nDATABASE_URL=postgres://x\n";
    const { next, added } = applyEnvKeysToDotenvContents(existing, {
      EMBED_BASE_URL: "http://localhost:11434",
      EMBED_MODEL: "nomic-embed-text",
    });
    expect(added).toEqual(["EMBED_BASE_URL", "EMBED_MODEL"]);
    expect(next).toContain("EMBED_BASE_URL=http://localhost:11434");
    expect(dotenvHasActiveKey(next, "EMBED_BASE_URL")).toBe(true);
  });

  test("does not overwrite an active key", () => {
    const existing = "EMBED_BASE_URL=https://api.openai.com/v1\n";
    const { next, added } = applyEnvKeysToDotenvContents(existing, {
      EMBED_BASE_URL: "http://localhost:11434",
      EMBED_MODEL: "nomic-embed-text",
    });
    expect(added).toEqual(["EMBED_MODEL"]);
    expect(next).toContain("EMBED_BASE_URL=https://api.openai.com/v1");
    expect(next).not.toContain("EMBED_BASE_URL=http://localhost:11434");
  });
});
