import { describe, expect, test } from "bun:test";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";
import {
  BEARER_CREDENTIAL_SENTINEL,
  encodeToolName,
  type ToolNameLimit,
} from "@intx/inference";
import {
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_PATH,
  createCodexResponsesAdapter,
  createResponsesBlockIndexer,
  isResponsesStreamTerminal,
  parseResponse,
} from "./codex-responses";
import {
  GROK_RESPONSES_PROVIDER,
  XAI_CLIENT_IDENTIFIER,
  XAI_RESPONSES_PATH,
  createGrokResponsesAdapter,
} from "./grok-responses";

const emptyTurns: ConversationTurn[] = [];
const options: InferenceOptions = { systemPrompt: "You are helpful." };

const SOURCE: LastCycleSource = {
  sourceId: "user-oauth:chatgpt-codex:gpt-5.6-sol",
  provider: "codex-responses",
  model: "gpt-5.6-sol",
};

const RESPONSES_LIMIT: ToolNameLimit = {
  provider: "codex-responses",
  maxLength: 64,
};

describe("createCodexResponsesAdapter", () => {
  test("builds a Responses request against the Codex path with bearer sentinel", () => {
    const adapter = createCodexResponsesAdapter({
      sourceId: "s1",
      provider: "codex-responses",
      model: "gpt-5.6-sol",
    });
    const req = adapter.buildRequest(emptyTurns, "gpt-5.6-sol", {
      ...options,
      providerOptions: { [CODEX_ACCOUNT_ID_OPTION]: "acct_123" },
    });
    expect(req.url).toBe(CODEX_RESPONSES_PATH);
    expect(req.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(req.headers["chatgpt-account-id"]).toBe("acct_123");
    expect(req.headers["originator"]).toBe(CODEX_ORIGINATOR);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-5.6-sol");
    expect(typeof body["instructions"]).toBe("string");
    expect(Array.isArray(body["input"])).toBe(true);
  });

  test("encodes package-qualified tool names on the wire", () => {
    const adapter = createCodexResponsesAdapter({
      sourceId: "s1",
      provider: "codex-responses",
      model: "gpt-5.6-sol",
    });
    const internalName = "@intx/tools-posix/sidecar-bundle:run_shell";
    const req = adapter.buildRequest(emptyTurns, "gpt-5.6-sol", {
      ...options,
      tools: [
        {
          name: internalName,
          description: "run a shell command",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const body = JSON.parse(req.body) as {
      tools: { name: string }[];
    };
    expect(body.tools[0]?.name).toBe(
      encodeToolName(internalName, RESPONSES_LIMIT),
    );
  });
});

describe("createGrokResponsesAdapter", () => {
  test("builds a Responses request against the Grok CLI proxy path", () => {
    const adapter = createGrokResponsesAdapter({
      sourceId: "s1",
      provider: GROK_RESPONSES_PROVIDER,
      model: "grok-composer-2.5-fast",
    });
    const req = adapter.buildRequest(
      emptyTurns,
      "grok-composer-2.5-fast",
      options,
    );
    expect(req.url).toBe(XAI_RESPONSES_PATH);
    expect(req.headers["authorization"]).toBe(BEARER_CREDENTIAL_SENTINEL);
    expect(req.headers["x-grok-client-identifier"]).toBe(XAI_CLIENT_IDENTIFIER);
    expect(req.headers["x-grok-model-override"]).toBe("grok-composer-2.5-fast");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body["model"]).toBe("grok-composer-2.5-fast");
    expect(Array.isArray(body["input"])).toBe(true);
  });
});

describe("Responses usage mapping (Insights path)", () => {
  test("response.completed maps token classes into inference.usage", () => {
    const indexer = createResponsesBlockIndexer();
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    });
    const events = parseResponse(sseData, indexer, SOURCE);
    const usageEvent = events.find((e) => e.type === "inference.usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type !== "inference.usage") return;
    expect(usageEvent.data.usage).toEqual({
      input: 120,
      output: 45,
      cacheRead: 30,
      cacheWrite: 0,
      thinking: 12,
    });
    expect(usageEvent.data.source).toEqual(SOURCE);
  });

  test("response.completed without usage emits nothing", () => {
    const indexer = createResponsesBlockIndexer();
    const events = parseResponse(
      JSON.stringify({ type: "response.completed", response: {} }),
      indexer,
      SOURCE,
    );
    expect(events.find((e) => e.type === "inference.usage")).toBeUndefined();
  });

  test("isResponsesStreamTerminal recognizes completed/incomplete", () => {
    expect(
      isResponsesStreamTerminal(JSON.stringify({ type: "response.completed" })),
    ).toBe(true);
    expect(
      isResponsesStreamTerminal(
        JSON.stringify({ type: "response.incomplete" }),
      ),
    ).toBe(true);
    expect(
      isResponsesStreamTerminal(
        JSON.stringify({ type: "response.output_text.delta", delta: "x" }),
      ),
    ).toBe(false);
  });

  test("function_call start decodes wire tool names", () => {
    const indexer = createResponsesBlockIndexer();
    const internalName = "@intx/tools-posix/sidecar-bundle:run_shell";
    const wireName = encodeToolName(internalName, RESPONSES_LIMIT);
    const events = parseResponse(
      JSON.stringify({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: wireName,
        },
      }),
      indexer,
      SOURCE,
    );
    const start = events.find((e) => e.type === "inference.tool_call.start");
    expect(start).toBeDefined();
    if (start?.type !== "inference.tool_call.start") return;
    expect(start.data.name).toBe(internalName);
    expect(start.data.callId).toBe("call_1");
  });
});
