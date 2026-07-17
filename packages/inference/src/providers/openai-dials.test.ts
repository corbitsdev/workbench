import { describe, expect, test } from "bun:test";
import type { LastCycleSource } from "@intx/types/runtime";
import { createOpenAIAdapter } from "./openai";

const TEST_SOURCE: LastCycleSource = {
  sourceId: "test-openai",
  provider: "openai",
  model: "test-openai-model",
};

function parseBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

describe("openai adapter CL-3766 dials", () => {
  test("merges reasoning_effort from providerOptions for deepseek", () => {
    const adapter = createOpenAIAdapter(TEST_SOURCE);
    const req = adapter.buildRequest([], "deepseek-v4-flash", {
      maxTokens: 100,
      providerOptions: { reasoning_effort: "high" },
    });
    const body = parseBody(req.body);
    expect(body["reasoning_effort"]).toBe("high");
  });

  test("kimi thinking enabled adds reasoning_content on assistant history", () => {
    const adapter = createOpenAIAdapter(TEST_SOURCE);
    const req = adapter.buildRequest(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      ],
      "kimi-k2.6",
      {
        maxTokens: 100,
        providerOptions: { thinking: { type: "enabled" } },
      },
    );
    const body = parseBody(req.body);
    const messages = body["messages"] as Record<string, unknown>[];
    const assistant = messages.find((m) => m["role"] === "assistant");
    expect(assistant?.["reasoning_content"]).toBe("");
  });

  test("kimi thinking enabled omits temperature on the wire", () => {
    const adapter = createOpenAIAdapter(TEST_SOURCE);
    const req = adapter.buildRequest([], "kimi-k2.6", {
      maxTokens: 100,
      temperature: 0.9,
      providerOptions: { thinking: { type: "enabled" } },
    });
    const body = parseBody(req.body);
    expect(body["temperature"]).toBeUndefined();
    expect(body["thinking"]).toEqual({ type: "enabled" });
  });

  test("kimi thinking disabled keeps temperature", () => {
    const adapter = createOpenAIAdapter(TEST_SOURCE);
    const req = adapter.buildRequest([], "kimi-k2.6", {
      maxTokens: 100,
      temperature: 0.7,
      providerOptions: { thinking: { type: "disabled" } },
    });
    const body = parseBody(req.body);
    expect(body["temperature"]).toBe(0.7);
    expect(body["thinking"]).toEqual({ type: "disabled" });
  });
});
