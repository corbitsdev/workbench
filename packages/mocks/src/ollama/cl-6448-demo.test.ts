// Demonstrates the exact shape of test that would have caught CL-6448
// before it shipped: the openai-compatible inference path sent
// `tools: []` and only `[system, latest user message]` — no history —
// on every turn, wire-proven by a logging proxy at 2am. No test anywhere
// asserted on the outgoing request shape; this is what one looks like.
import { describe, expect, test } from "bun:test";
import { createOllamaMock } from "./index";

// Stands in for the real call site (`@intx/inference`'s openai adapter,
// invoked through workbench's turn assembly) — a launch/turn assembler
// that is SUPPOSED to forward the agent's declared tools and the full
// conversation history, but has regressed to CL-6448's broken shape.
async function assembleAndSendBrokenTurn(
  fetchImpl: (req: Request) => Promise<Response>,
  baseURL: string,
): Promise<void> {
  await fetchImpl(
    new Request(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.8:27b",
        // CL-6448 D2: tools declared upstream, but an empty list reaches
        // the wire.
        tools: [],
        // CL-6448 D3: history collapsed to just the latest turn — no
        // system prompt, no prior assistant/tool turns.
        messages: [{ role: "user", content: "this is turn 17" }],
        stream: false,
      }),
    }),
  );
}

async function assembleAndSendCorrectTurn(
  fetchImpl: (req: Request) => Promise<Response>,
  baseURL: string,
): Promise<void> {
  await fetchImpl(
    new Request(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.8:27b",
        tools: [
          { type: "function", function: { name: "create_agent" } },
          { type: "function", function: { name: "send_message" } },
        ],
        messages: [
          { role: "system", content: "6.5KB of tool doctrine" },
          { role: "user", content: "turn 1" },
          { role: "assistant", content: "reply 1" },
          { role: "user", content: "this is turn 17" },
        ],
        stream: false,
      }),
    }),
  );
}

describe("CL-6448 regression shape", () => {
  test("expectToolsDeclared catches an empty tools array reaching the model", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("[Called create_agent: ...]"));

    await assembleAndSendBrokenTurn(ollama.fetch, "http://mock-ollama");

    expect(() => ollama.requests.last().expectToolsDeclared()).toThrow(
      /tools was empty or missing/,
    );
  });

  test("expectHistoryContains catches a turn with no conversation history", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("this is the first message"));

    await assembleAndSendBrokenTurn(ollama.fetch, "http://mock-ollama");

    expect(() =>
      ollama.requests
        .last()
        .expectHistoryContains([
          { role: "system" },
          { role: "user", content: "turn 1" },
        ]),
    ).toThrow(/expected history to contain/);
  });

  test("the same assertions pass once tools and history are actually sent", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.toolCall("create_agent", {}));

    await assembleAndSendCorrectTurn(ollama.fetch, "http://mock-ollama");

    const request = ollama.requests.last();
    expect(() =>
      request.expectToolsDeclared(["create_agent", "send_message"]),
    ).not.toThrow();
    expect(() =>
      request.expectHistoryContains([
        { role: "system" },
        { role: "user", content: "turn 1" },
        { role: "assistant" },
        { role: "user", content: "turn 17" },
      ]),
    ).not.toThrow();
  });
});
