import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  catalogTools,
  ESTIMATE_RUN_COST_TOOL,
  LIST_MODEL_CONCEPTS_TOOL,
  PICK_MODELS_TOOL,
  type WorkflowCatalogEnv,
} from "./tool";

const CHAIN_BODY = {
  concept: "cheap-loop",
  requiredCapabilities: ["plain-text"],
  entries: [
    {
      canonicalName: "thrifty",
      displayName: "Thrifty",
      providerName: "globex",
      plugin: "openai-compatible",
      offeringId: "off_1",
      capabilities: ["plain-text"],
      price: {
        currency: "USD",
        known: true,
        inputUsdPerMTok: 0.1,
        outputUsdPerMTok: 0.4,
      },
      referenceCostUsd: 0.12,
      overCeiling: false,
    },
    {
      canonicalName: "mystery",
      displayName: null,
      providerName: "initech",
      plugin: "openai-compatible",
      offeringId: "off_2",
      capabilities: ["plain-text"],
      price: {
        currency: "USD",
        known: false,
        inputUsdPerMTok: null,
        outputUsdPerMTok: null,
      },
      referenceCostUsd: null,
      overCeiling: false,
    },
  ],
  note: null,
};

function env(fetchImpl?: typeof fetch): WorkflowCatalogEnv {
  return {
    hubCatalogUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetch: fetchImpl,
  } as unknown as WorkflowCatalogEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

function stubbing(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
    })) as unknown as typeof fetch;
}

describe("the bundle's shape", () => {
  test("declares three tools, none gated behind approval", () => {
    expect(catalogTools.definitions).toEqual([
      { name: LIST_MODEL_CONCEPTS_TOOL },
      { name: PICK_MODELS_TOOL },
      { name: ESTIMATE_RUN_COST_TOOL },
    ]);
  });

  test("requires the sanctioned workflow-run env keys", () => {
    expect(catalogTools.requires).toEqual([
      "hubCatalogUrl",
      "sidecarToken",
      "address",
    ]);
  });

  test("no tool takes a model name, and the capability list is the real vocabulary", () => {
    const definitions = catalogTools(env()).definitions;
    for (const definition of definitions) {
      const schema = definition.inputSchema as {
        properties: Record<string, { items?: { enum?: string[] } }>;
      };
      expect(Object.keys(schema.properties)).not.toContain("model");
      const capabilities = schema.properties["capabilities"];
      if (capabilities !== undefined) {
        expect(capabilities.items?.enum).toContain("plain-text");
        expect(capabilities.items?.enum).not.toContain("telepathy");
      }
    }
  });
});

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
    stubbing(CHAIN_BODY);
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
    stubbing(CHAIN_BODY);
    const result = await catalogTools(env()).run(
      callFor(PICK_MODELS_TOOL, { concept: "cheap-loop" }),
      new AbortController().signal,
    );
    expect(String(result.content)).toContain("no price on record");
    expect(String(result.content)).not.toContain("$0.00 in");
  });

  test("an empty chain says nothing here can do it, without inventing a model", async () => {
    stubbing({
      concept: "image-maker",
      requiredCapabilities: ["image-output"],
      entries: [],
      note: "nothing on this bench can do that",
    });
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
    stubbing({
      concept: "cheap-loop",
      estimates: [
        {
          canonicalName: "mystery",
          providerName: "initech",
          known: false,
          estimatedUsd: null,
        },
      ],
    });
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
    stubbing({
      data: [
        {
          id: "cheap-loop",
          title: "Cheap loop",
          whenToUse: "A step that runs hundreds of times.",
          availableModels: 2,
          headProvider: "globex",
        },
        {
          id: "image-maker",
          title: "Image maker",
          whenToUse: "Produce a picture rather than words.",
          availableModels: 0,
          headProvider: null,
        },
      ],
    });
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
