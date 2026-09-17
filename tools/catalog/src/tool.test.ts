import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  catalogTools,
  ESTIMATE_RUN_COST_TOOL,
  LIST_MODEL_CONCEPTS_TOOL,
  PICK_MODELS_TOOL,
  type WorkflowCatalogEnv,
} from "./tool";

const CHEAP_LOOP_MODELS = [
  {
    id: "m1",
    canonicalName: "thrifty",
    displayName: "Thrifty",
    offerings: [
      {
        offeringId: "off_1",
        providerName: "globex",
        plugin: "openai-compatible",
        priority: 0,
        capabilities: ["plain-text"],
        pricing: [
          {
            offeringId: "off_1",
            currency: "USD",
            inputTokenPrice: "0.0000001",
            outputTokenPrice: "0.0000004",
          },
        ],
      },
    ],
  },
  {
    id: "m2",
    canonicalName: "mystery",
    displayName: null,
    offerings: [
      {
        offeringId: "off_2",
        providerName: "initech",
        plugin: "openai-compatible",
        priority: 1,
        capabilities: ["plain-text"],
        pricing: [],
      },
    ],
  },
];

const IMAGE_MAKER_MODELS = [
  {
    id: "m1",
    canonicalName: "thrifty",
    displayName: "Thrifty",
    offerings: [
      {
        offeringId: "off_1",
        providerName: "globex",
        plugin: "openai-compatible",
        priority: 0,
        capabilities: ["plain-text"],
        pricing: [],
      },
    ],
  },
];

function env(): WorkflowCatalogEnv {
  return {
    hubCatalogUrl: "https://hub.example.com",
    tenantId: "bench_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowCatalogEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

/** Stubs both stock reads `readBenchCatalog` makes: the model list at
 * `/models`, and the tenant itself (for its config's model policy). */
function stubbing(models: unknown, config?: Record<string, unknown>): void {
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify(models), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "bench_1", config: config ?? null }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("pick_models", () => {
  test("naming both a concept and capabilities is refused, and says why", async () => {
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, {
        concept: "cheap-loop",
        capabilities: ["plain-text"],
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exactly one");
  });

  test("naming neither is refused too", async () => {
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  test("a capability outside the vocabulary never reaches the hub", async () => {
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, { capabilities: ["telepathy"] }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  test("names every model in the chain, in order, and no model that is not", async () => {
    stubbing(CHEAP_LOOP_MODELS);
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, { concept: "cheap-loop" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    const content = String(result.content);
    expect(content.indexOf("Thrifty")).toBeLessThan(content.indexOf("mystery"));
    expect(content).toContain("fallbacks");
    expect(content).not.toContain("claude");
    expect(content).not.toContain("gpt");
  });

  test("an unpriced model is reported as unpriced, never as free", async () => {
    stubbing(CHEAP_LOOP_MODELS);
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, { concept: "cheap-loop" }),
      new AbortController().signal,
    );
    expect(String(result.content)).toContain("no price on record");
    expect(String(result.content)).not.toContain("$0.00 in");
  });

  test("an empty chain says nothing here can do it, without inventing a model", async () => {
    stubbing(IMAGE_MAKER_MODELS);
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, { concept: "image-maker" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("nothing on this bench can do that");
  });
});

describe("estimate_run_cost", () => {
  test("reports an honest no-estimate for an unpriced model", async () => {
    stubbing(CHEAP_LOOP_MODELS);
    const result = await catalogTools(env()).run(
      callFor(ESTIMATE_RUN_COST_TOOL, {
        concept: "cheap-loop",
        expectedInputTokens: 1000,
        expectedOutputTokens: 100,
      }),
      new AbortController().signal,
    );
    expect(String(result.content)).toContain("no price on record");
  });

  test("token counts are required", async () => {
    const result = await catalogTools(env()).run(
      callFor(ESTIMATE_RUN_COST_TOOL, { concept: "cheap-loop" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });
});

describe("list_model_concepts", () => {
  test("says how many models this bench has for each kind of work", async () => {
    stubbing(CHEAP_LOOP_MODELS);
    const result = await catalogTools(env()).run(
      callFor(LIST_MODEL_CONCEPTS_TOOL, {}),
      new AbortController().signal,
    );
    const content = String(result.content);
    expect(content).toContain("cheap-loop");
    expect(content).toContain("2 models here, best via globex");
    expect(content).toContain("nothing here can do it yet");
  });
});
// Catalog administration is UI-only (CL-7588): no write tools, so no
// write-tool tests — the read-only describes above are the whole suite.
