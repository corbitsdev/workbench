import { describe, expect, test } from "bun:test";
import { planEmbedding, planRerank } from "./setup-memory";

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
