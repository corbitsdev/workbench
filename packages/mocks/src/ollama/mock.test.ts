import { describe, expect, test } from "bun:test";
import { createOllamaMock } from "./index";

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

describe("createOllamaMock: model catalogue", () => {
  test("serves a scripted /api/tags with no models pulled", async () => {
    const ollama = createOllamaMock({
      models: [
        { name: "qwen3.8:27b", capabilities: ["completion", "tools"] },
        { name: "embeddinggemma:300m", capabilities: ["embedding"] },
      ],
    });

    const response = await ollama.fetch(
      new Request("http://mock-ollama/api/tags"),
    );
    const body = (await response.json()) as { models: { name: string }[] };

    expect(response.status).toBe(200);
    expect(body.models.map((m) => m.name)).toEqual([
      "qwen3.8:27b",
      "embeddinggemma:300m",
    ]);
  });

  test("setModels updates the catalogue a test connects against mid-run", async () => {
    const ollama = createOllamaMock({ models: [] });
    ollama.setModels([{ name: "qwen3.8:27b" }]);

    const response = await ollama.fetch(
      new Request("http://mock-ollama/api/tags"),
    );
    const body = (await response.json()) as { models: { name: string }[] };
    expect(body.models).toHaveLength(1);
  });

  test("/api/show answers each model's own scripted capabilities", async () => {
    const ollama = createOllamaMock({
      models: [{ name: "embeddinggemma:300m", capabilities: ["embedding"] }],
    });

    const response = await ollama.fetch(
      new Request("http://mock-ollama/api/show", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "embeddinggemma:300m" }),
      }),
    );
    const body = (await response.json()) as { capabilities: string[] };
    expect(body.capabilities).toEqual(["embedding"]);
  });
});

describe("createOllamaMock: chat completions", () => {
  test("non-streaming reply carries the scripted text", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("hi there"));

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    const body = (await response.json()) as {
      choices: { message: { content: string }; finish_reason: string }[];
    };

    expect(body.choices[0]?.message.content).toBe("hi there");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  test("streaming reply is SSE, terminated with [DONE]", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("streamed"));

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const text = await response.text();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(text).toContain('"content":"streamed"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  test("tool-call reply carries function name and JSON-encoded arguments", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() =>
      ollama.reply.toolCall("create_agent", { name: "researcher" }),
    );

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "make me an agent" }],
      tools: [{ type: "function", function: { name: "create_agent" } }],
      stream: false,
    });
    const body = (await response.json()) as {
      choices: {
        message: {
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
        finish_reason: string;
      }[];
    };
    const call = body.choices[0]?.message.tool_calls?.[0];

    expect(call?.function.name).toBe("create_agent");
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
      name: "researcher",
    });
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("rejects a malformed request body instead of crashing", async () => {
    const ollama = createOllamaMock();
    const response = await chat(ollama.fetch, { model: 123, messages: "nope" });
    expect(response.status).toBe(400);
  });
});

describe("createOllamaMock: request capture", () => {
  test("records every chat request in order", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("ok"));

    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "first" }],
    });
    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "second" }],
    });

    expect(ollama.requests.count).toBe(2);
    expect(ollama.requests.all[0]?.messages[0]?.content).toBe("first");
    expect(ollama.requests.last().messages[0]?.content).toBe("second");
  });

  test("last() throws when nothing has been captured yet", () => {
    const ollama = createOllamaMock();
    expect(() => ollama.requests.last()).toThrow(/no chat request/i);
  });
});

describe("CapturedChatRequest assertions", () => {
  test("expectModel throws with the actual model on mismatch", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("ok"));
    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(() =>
      ollama.requests.last().expectModel("qwen3.8:27b"),
    ).not.toThrow();
    expect(() => ollama.requests.last().expectModel("other-model")).toThrow(
      /qwen3\.8:27b/,
    );
  });

  test("expectToolsDeclared(names) enforces the exact declared set", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("ok"));
    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "send_message" } }],
    });

    const request = ollama.requests.last();
    expect(() => request.expectToolsDeclared(["send_message"])).not.toThrow();
    expect(() => request.expectToolsDeclared(["create_agent"])).toThrow();
  });

  test("expectMessageRoles catches history collapsing to just [system, user]", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("ok"));
    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [
        { role: "system", content: "doctrine" },
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 17" },
      ],
    });

    const request = ollama.requests.last();
    expect(() =>
      request.expectMessageRoles(["system", "user", "assistant", "user"]),
    ).not.toThrow();
    expect(() => request.expectMessageRoles(["system", "user"])).toThrow();
  });

  test("expectHistoryContains finds an ordered subsequence", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.text("ok"));
    await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [
        { role: "system", content: "doctrine" },
        { role: "user", content: "book me a flight" },
        { role: "assistant", content: "calling search_flights" },
        { role: "tool", content: "3 results", tool_call_id: "call_0" },
      ],
    });

    const request = ollama.requests.last();
    expect(() =>
      request.expectHistoryContains([
        { role: "user", content: "book me a flight" },
        { role: "tool" },
      ]),
    ).not.toThrow();
    expect(() =>
      request.expectHistoryContains([{ role: "user", content: "never sent" }]),
    ).toThrow();
  });
});

describe("createOllamaMock: as a server", () => {
  test("listen() serves the same routes over real HTTP", async () => {
    const ollama = createOllamaMock({ models: [{ name: "qwen3.8:27b" }] });
    const server = await ollama.listen();
    try {
      const response = await fetch(`${server.url}/api/tags`);
      const body = (await response.json()) as { models: { name: string }[] };
      expect(body.models[0]?.name).toBe("qwen3.8:27b");
    } finally {
      await server.close();
    }
  });
});
