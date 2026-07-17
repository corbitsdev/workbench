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

const { createSummarizeCompactor, RETAIN_RECENT_EXCHANGES } = await import(
  "./summarize-compactor"
);
const { SUMMARY_AGENT_DEPLOY_DESCRIPTOR } = await import(
  "./summary-agent/definition"
);

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
        t.content.length === 1 &&
        t.content[0]?.type === "text" &&
        t.content[0].text === "FAKE SUMMARY TEXT",
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
    expect(result.record.decisions.kept).toBe(1 + expectedTailLength);
  });

  test("uses the summary agent's model for the compaction inference call, not the caller's source model", async () => {
    runInferenceCalls = [];
    runInferenceBehavior = "succeed";
    const compactor = createSummarizeCompactor({ source: SOURCE, deps: DEPS });
    await compactor.apply(buildLongConversation(), {
      state: {} as never,
      trigger: "test-trigger",
    });

    expect(runInferenceCalls).toHaveLength(1);
    expect(runInferenceCalls[0]?.source.model).toBe(
      SUMMARY_AGENT_DEPLOY_DESCRIPTOR.modelConfig?.defaultModel,
    );
    expect(runInferenceCalls[0]?.source.model).not.toBe(SOURCE.model);
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
