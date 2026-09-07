// CL-6448 regression guard at the request-assembly layer.
//
// The section-body (chat turn) defect was invisible to every unit above
// the wire: the agent ran, the reply streamed, and only the outbound
// inference request showed the loss — `tools` absent and `messages`
// holding just the system prompt plus the latest user message. This
// suite pins the contract at exactly that layer: a real `createAgent`
// send with a captured `deps.fetch` asserts the literal HTTP body an
// OpenAI-compatible provider receives carries BOTH the prior
// conversation turns the context store restored AND the agent's
// declared tools.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAgent,
  createDefaultDirectorRegistry,
  defineAgent,
  defineTool,
} from "@intx/agent";
import { createDependencies } from "@intx/inference";
import { createBuiltinRegistry } from "@intx/inference/providers";

const PRIOR_TURNS = [
  {
    role: "user",
    content: [{ type: "text", text: "My favorite color is teal." }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Noted: teal." }],
  },
];

function contextStoreStub() {
  return {
    load: () =>
      Promise.resolve({
        turns: PRIOR_TURNS,
        pendingOperations: [],
        tokenUsage: undefined,
      }),
    writeTurns: () => Promise.resolve(),
    writePrompt: () => Promise.resolve(),
    writeResponse: () => Promise.resolve(),
    writeManifest: () => Promise.resolve(),
    writeMetadata: () => Promise.resolve(),
    writeBlob: () => Promise.resolve(),
    commit: () => Promise.resolve({ commitId: "stub" }),
    record: () => Promise.resolve(),
  };
}

function sseResponse(): Response {
  const chunk = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "ok" },
        finish_reason: null,
      },
    ],
  };
  const stop = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  const body = [
    `data: ${JSON.stringify(chunk)}`,
    "",
    `data: ${JSON.stringify(stop)}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("an openai-compatible turn's wire request carries the restored history and the declared tools", async () => {
  const captured: { url?: string; body?: unknown } = {};
  const fetchStub = (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    return Promise.resolve(sseResponse());
  };

  const echoDefinition = {
    name: "@corbits/test-tools/echo",
    description: "Echo the input back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
  };
  const echoFactory = defineTool({
    id: "@corbits/test-tools/echo",
    definitions: [echoDefinition],
    factory: () => ({
      definitions: [echoDefinition],
      run: (call: { callId: string }) =>
        Promise.resolve({
          callId: call.callId,
          content: [{ type: "text" as const, text: "ok" }],
          isError: false,
        }),
    }),
  } as never);

  const definition = defineAgent({
    id: "body-turn-assembly-test",
    systemPrompt: "You are the assembly-regression fixture.",
    tools: [echoFactory],
    capabilities: [],
    inference: { sources: [{ provider: "openai", model: "stub-model" }] },
  });

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cl6448-assembly-"));
  const storage = contextStoreStub();
  const agent = await createAgent(
    definition as never,
    {
      sources: [
        {
          id: "src-openai-stub",
          provider: "openai",
          baseURL: "http://inference.stub.invalid/v1",
          credentialId: "stub-key",
          model: "stub-model",
        },
      ],
      defaultSource: "src-openai-stub",
      // An `InferenceSource` names a `credentialId`; the reactor fills the
      // request's secret through this resolver at send time.
      readCurrentMaterial: () => ({ secret: "stub-secret" }),
      storage,
      audit: storage,
      workdir,
      directors: createDefaultDirectorRegistry(),
      authorize: () => Promise.resolve({ effect: "allow" }),
      deps: {
        ...createDependencies(createBuiltinRegistry()),
        fetch: fetchStub,
      },
    } as never,
  );

  try {
    await agent.send("What is my favorite color?");
  } finally {
    await agent.close();
  }

  expect(captured.url).toBe(
    "http://inference.stub.invalid/v1/chat/completions",
  );
  const request = captured.body as {
    messages: { role: string; content: unknown }[];
    tools?: { function: { name: string } }[];
  };

  // History: every prior turn the context store restored precedes the
  // new user message on the wire.
  const serialized = JSON.stringify(request.messages);
  expect(serialized).toContain("My favorite color is teal.");
  expect(serialized).toContain("Noted: teal.");
  expect(serialized).toContain("What is my favorite color?");
  const roles = request.messages.map((m) => m.role);
  expect(roles[0]).toBe("system");
  expect(roles).toContain("assistant");

  // Tools: the declared tool rides the request (name is
  // provider-encoded, so match on the stable suffix).
  expect(request.tools).toBeDefined();
  expect(request.tools?.length).toBe(1);
  expect(request.tools?.[0]?.function.name).toContain("echo");
});
