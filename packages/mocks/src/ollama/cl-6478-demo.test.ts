// Demonstrates the exact shape of test that would have caught CL-6478
// before it shipped: qwen3.8:27b emitted `\n</parameter` inside a tool-call
// function name. A turn assembler that persists that name into history
// verbatim -- as ours did -- carries the malformed fragment forward on
// every following turn; @intx/inference's encodeToolName then throws
// re-encoding it, so the room dies rebuilding its request forever.
//
// The real fix is `sanitizeToolNameForPersistence` in
// vendor/intx/hub-sessions/src/sanitize-tool-name.ts, which collapses an
// unencodable name to a stable placeholder before it is ever persisted.
// That guard is demonstrated here at the mock layer only -- wiring an
// equivalent regression test through the real hub-sessions turn assembler
// is a follow-up, not covered by this unit.
import { describe, expect, test } from "bun:test";
import { createOllamaMock, sequence } from "./index";

type ChatCompletionBody = {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
};

async function chat(
  fetchImpl: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<Response> {
  return fetchImpl(
    new Request("http://mock-ollama/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// Stands in for hub-sessions's turn assembler persisting the PRECEDING
// assistant reply -- tool_calls included -- into the next turn's history
// before sending. This is the persistence step CL-6478's fix guards.
async function assembleAndSendNextTurn(
  fetchImpl: (req: Request) => Promise<Response>,
  priorAssistantMessage: unknown,
  nextTurnContent: string,
): Promise<Response> {
  return chat(fetchImpl, {
    model: "qwen3.8:27b",
    tools: [{ type: "function", function: { name: "run_shell" } }],
    messages: [
      { role: "system", content: "doctrine" },
      { role: "user", content: "run the sidecar bundle" },
      priorAssistantMessage,
      { role: "user", content: nextTurnContent },
    ],
    stream: false,
  });
}

describe("CL-6478 regression shape", () => {
  test("a turn assembler that persists the malformed name unchanged carries it into every following turn's history", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(
      sequence([
        ollama.reply.malformedToolName(),
        ollama.reply.text("turn 2, room still alive"),
      ]),
    );

    const turn1Response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      tools: [{ type: "function", function: { name: "run_shell" } }],
      messages: [
        { role: "system", content: "doctrine" },
        { role: "user", content: "run the sidecar bundle" },
      ],
      stream: false,
    });
    const turn1Body = (await turn1Response.json()) as ChatCompletionBody;
    const brokenToolCall = turn1Body.choices[0]?.message.tool_calls?.[0];
    expect(brokenToolCall?.function.name).toContain("\n</parameter");

    // The buggy assembler: append turn 1's assistant reply -- broken tool
    // name included -- straight into turn 2's history, unsanitized.
    await assembleAndSendNextTurn(
      ollama.fetch,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: brokenToolCall?.function,
          },
        ],
      },
      "did that work?",
    );

    const turn2Request = ollama.requests.last();

    // This is the regression guard: the malformed name persisted straight
    // into history is exactly what would have caught CL-6478 -- a real
    // sanitizer must intercept it here, before the next turn's request is
    // even built, or the room is already bricked.
    expect(
      turn2Request.messages.some((message) =>
        message.toolCalls?.some((call) => call.name.includes("\n</parameter")),
      ),
    ).toBe(true);
  });

  test("with the room's history sanitized (CL-6478's fix applied), the next turn survives with a normal reply", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(
      sequence([
        ollama.reply.malformedToolName(),
        ollama.reply.text("turn 2, room still alive"),
      ]),
    );

    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      tools: [{ type: "function", function: { name: "run_shell" } }],
      messages: [
        { role: "system", content: "doctrine" },
        { role: "user", content: "run the sidecar bundle" },
      ],
      stream: false,
    });

    // A correct assembler runs sanitizeToolNameForPersistence (or
    // equivalent) before persisting -- the malformed fragment never
    // reaches history. Simulated here as the placeholder name the real
    // sanitizer collapses onto (MALFORMED_TOOL_NAME in
    // vendor/intx/hub-sessions/src/sanitize-tool-name.ts).
    const turn2Response = await assembleAndSendNextTurn(
      ollama.fetch,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "malformed_tool_call", arguments: "{}" },
          },
        ],
      },
      "did that work?",
    );
    const turn2Body = (await turn2Response.json()) as ChatCompletionBody;

    expect(turn2Body.choices[0]?.message.content).toBe(
      "turn 2, room still alive",
    );
    expect(
      ollama.requests
        .last()
        .messages.some((message) =>
          message.toolCalls?.some((call) =>
            call.name.includes("\n</parameter"),
          ),
        ),
    ).toBe(false);
  });
});
