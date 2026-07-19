import { describe, expect, mock, test } from "bun:test";
import type { ConversationTurn, InferenceEvent } from "@intx/types/runtime";

let runInferenceCalls: {
  turns: ConversationTurn[];
  source: { model: string };
}[] = [];
let runInferenceBehavior: "succeed" | "throw" | "empty" = "succeed";

mock.module("@workbench/inference", () => ({
  runInference: (opts: {
    turns: ConversationTurn[];
    source: { model: string };
  }): AsyncIterable<InferenceEvent> => {
    runInferenceCalls.push(opts);
    if (runInferenceBehavior === "throw") {
      throw new Error("summarize inference boom");
    }
    async function* gen(): AsyncGenerator<InferenceEvent> {
      if (runInferenceBehavior === "empty") {
        yield {
          type: "inference.done",
          seq: 0,
          data: {
            turn: {
              role: "assistant",
              content: [],
              model: opts.source.model,
              timestamp: 0,
            },
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              thinking: 0,
            },
            source: { sourceId: "s", provider: "p", model: opts.source.model },
          },
        } as InferenceEvent;
        return;
      }
      yield {
        type: "inference.done",
        seq: 0,
        data: {
          turn: {
            role: "assistant",
            content: [{ type: "text", text: "FAKE SUMMARY TEXT" }],
            model: opts.source.model,
            timestamp: 0,
          },
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
          },
          source: { sourceId: "s", provider: "p", model: opts.source.model },
        },
      } as InferenceEvent;
    }
    return gen();
  },
}));

const {
  createSummarizeCompactor,
  RETAIN_RECENT_EXCHANGES,
  resolveCompactorSource,
  SUMMARY_MODEL_ID,
  SUMMARY_MODEL_PROVIDER,
} = await import("./summarize-compactor");

function userTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function assistantTurn(text: string): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "some-model",
    timestamp: Date.now(),
  };
}

const SOURCE = {
  id: "test-source",
  provider: "openai-compatible",
  baseURL: "http://localhost:1",
  apiKey: "test-key",
  model: "agent-default-model",
};

const DEPS = {
  fetch: (() => {
    throw new Error("must not be called — runInference is mocked");
  }) as unknown as (typeof globalThis)["fetch"],
  scheduler: { now: () => 0, setTimeout: () => () => {} },
  adapters: { has: () => true, resolve: () => undefined } as never,
};

function buildLongConversation(): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < 6; i++) {
    turns.push(userTurn(`user message ${i}`));
    turns.push(assistantTurn(`assistant reply ${i}`));
  }
  return turns;
}

describe("createSummarizeCompactor", () => {
  test("replaces the conversation with one summary turn plus the retained recent exchanges", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });
    const turns = buildLongConversation();

    const result = await compactor.apply(turns, {
      state: {} as never,
      trigger: "test-trigger",
    });

    const summaryTurns = result.output.filter(
      (t) =>
        t.role === "user" &&
        t.content.length === 1 &&
        t.content[0]?.type === "text" &&
        t.content[0].text.includes("FAKE SUMMARY TEXT"),
    );
    expect(summaryTurns).toHaveLength(1);
    expect(
      summaryTurns[0]?.content.some(
        (b) => b.type === "tool_call" || b.type === "tool_result",
      ),
    ).toBe(false);

    const retainedExchangeCount = RETAIN_RECENT_EXCHANGES;
    // Each exchange in buildLongConversation is exactly [user, assistant].
    const expectedTailLength = retainedExchangeCount * 2;
    expect(result.output).toHaveLength(1 + expectedTailLength);

    const tail = result.output.slice(1);
    expect(tail[0]).toEqual(turns[turns.length - expectedTailLength]);
    expect(tail[tail.length - 1]).toEqual(turns[turns.length - 1]);

    expect(result.record.strategy).toBe("summarize");
    expect(result.record.decisions.kept).toBe(expectedTailLength);
    expect(result.record.decisions.dropped).toBe(
      turns.length - expectedTailLength,
    );
  });

  test("emits the summary as a user turn, not assistant, so the compacted output stays valid on providers requiring a user-first message", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });

    const result = await compactor.apply(buildLongConversation(), {
      state: {} as never,
      trigger: "test-trigger",
    });

    expect(result.output[0]?.role).toBe("user");
  });

  test("runs the compaction inference on the caller's source verbatim, without mutating its model", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });
    await compactor.apply(buildLongConversation(), {
      state: {} as never,
      trigger: "test-trigger",
    });

    expect(runInferenceCalls).toHaveLength(1);
    expect(runInferenceCalls[0]?.source).toEqual(SOURCE);
    expect(runInferenceCalls[0]?.source.model).toBe(SOURCE.model);
  });

  test("never produces a tail that opens with an orphan tool_result", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });

    const turns: ConversationTurn[] = [
      userTurn("do something"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "some_tool", arguments: {} },
        ],
        model: "m",
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
        timestamp: Date.now(),
      },
      userTurn("next question"),
      assistantTurn("next answer"),
    ];
    // Exchanges (split at each user-role turn): [do-something, tool_call],
    // [tool_result], [next-question, next-answer]. RETAIN_RECENT_EXCHANGES=2
    // pulls the last two exchanges into the tail, which starts with the
    // lone tool_result turn — an orphan once its tool_call's exchange is
    // summarized away. This is the case dropLeadingOrphanToolResult exists
    // to fix.

    const result = await compactor.apply(turns, {
      state: {} as never,
      trigger: "test-trigger",
    });

    const tail = result.output.slice(1);
    expect(
      tail.some((t) => t.content.some((block) => block.type === "tool_result")),
    ).toBe(false);
    const firstTailTurn = tail[0];
    expect(firstTailTurn).toBeDefined();
    expect(firstTailTurn?.content[0]).toEqual({
      type: "text",
      text: "next question",
    });
  });

  test("never produces a tail that ends with an orphan tool_call", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });

    const turns: ConversationTurn[] = [
      userTurn("earlier question"),
      assistantTurn("earlier answer"),
      userTurn("do something"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "some_tool", arguments: {} },
        ],
        model: "m",
        timestamp: Date.now(),
      },
    ];
    // Exchanges: [earlier question, earlier answer], [do something, tool_call].
    // RETAIN_RECENT_EXCHANGES=2 pulls both into the tail, which ends with a
    // trailing tool_call whose result never arrived — dropTrailingOrphanToolCall
    // must strip it so the compacted output isn't left with a dangling call.

    const result = await compactor.apply(turns, {
      state: {} as never,
      trigger: "test-trigger",
    });

    const tail = result.output.slice(1);
    expect(
      tail.some((t) => t.content.some((block) => block.type === "tool_call")),
    ).toBe(false);
  });

  test("renders tool_result content and non-text blocks into the summarizer input instead of dropping them", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });

    const turns: ConversationTurn[] = [
      userTurn("look this up"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "lookup",
            arguments: {},
          },
        ],
        model: "m",
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "call-1",
            content: [
              { type: "text", text: "the critical fact the model must keep" },
            ],
          },
        ],
        timestamp: Date.now(),
      },
      ...buildLongConversation(),
    ];

    await compactor.apply(turns, {
      state: {} as never,
      trigger: "test-trigger",
    });

    expect(runInferenceCalls).toHaveLength(1);
    const conversationTurn = runInferenceCalls[0]?.turns[1];
    const renderedText =
      conversationTurn?.content[0]?.type === "text"
        ? conversationTurn.content[0].text
        : undefined;
    expect(renderedText).toContain("the critical fact the model must keep");
  });

  test("fails safe and returns the input turns unchanged when the summarize inference throws", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "throw";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });
    const turns = buildLongConversation();

    const result = await compactor.apply(turns, {
      state: {} as never,
      trigger: "test-trigger",
    });

    expect(result.output).toEqual(turns);
  });

  test("fails safe and returns the input turns unchanged when the summarize inference yields no text", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "empty";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });
    const turns = buildLongConversation();

    const result = await compactor.apply(turns, {
      state: {} as never,
      trigger: "test-trigger",
    });

    expect(result.output).toEqual(turns);
  });
});

describe("resolveCompactorSource", () => {
  test("pins SUMMARY_MODEL_ID on an openai-compatible source", () => {
    const anthropic = {
      id: "a",
      provider: "anthropic",
      model: "claude-opus-4-6",
      baseURL: "https://api.anthropic.com",
      apiKey: "k",
    };
    const openaiCompat = {
      id: "o",
      provider: SUMMARY_MODEL_PROVIDER,
      model: "some-other-model",
      baseURL: "http://localhost:1",
      apiKey: "k",
    };
    const resolved = resolveCompactorSource([anthropic, openaiCompat]);
    expect(resolved.usesCheapSummaryModel).toBe(true);
    expect(resolved.reason).toBe("cheap-summary-provider");
    expect(resolved.source).toEqual({
      ...openaiCompat,
      model: SUMMARY_MODEL_ID,
    });
  });

  test("falls back to the agent default when no openai-compatible source is present", () => {
    const anthropic = {
      id: "a",
      provider: "anthropic",
      model: "claude-opus-4-6",
      baseURL: "https://api.anthropic.com",
      apiKey: "k",
    };
    const resolved = resolveCompactorSource([anthropic]);
    expect(resolved.usesCheapSummaryModel).toBe(false);
    expect(resolved.reason).toBe("agent-default-fallback");
    expect(resolved.source).toEqual(anthropic);
  });

  test("throws when the sources list is empty", () => {
    expect(() => resolveCompactorSource([])).toThrow(
      /no inference sources available/,
    );
  });
});
