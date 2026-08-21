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
import { createOllamaMock } from "@corbits/mocks/ollama";

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

test("an openai-compatible turn's wire request carries the restored history and the declared tools", async () => {
  // `OllamaMock`'s `/v1/chat/completions` route is provider-agnostic (it
  // matches on path, not host) and doubles as the OpenAI-compatible wire
  // format this agent's `openai` provider speaks, so it stands in here
  // without pretending to be Ollama specifically -- real SSE framing and
  // request validation instead of a hand-rolled stub.
  const ollama = createOllamaMock();

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
          apiKey: "stub-key",
          model: "stub-model",
        },
      ],
      defaultSource: "src-openai-stub",
      storage,
      audit: storage,
      workdir,
      directors: createDefaultDirectorRegistry(),
      authorize: () => Promise.resolve({ effect: "allow" }),
      deps: {
        ...createDependencies(createBuiltinRegistry()),
        fetch: ollama.fetch,
      },
    } as never,
  );

  try {
    await agent.send("What is my favorite color?");
  } finally {
    await agent.close();
  }

  const request = ollama.requests.last();

  // History: every prior turn the context store restored precedes the
  // new user message on the wire, and the roles land in the expected
  // order -- not just present somewhere in the serialized blob.
  request.expectHistoryContains([
    { role: "system" },
    { role: "user", content: "My favorite color is teal." },
    { role: "assistant", content: "Noted: teal." },
    { role: "user", content: "What is my favorite color?" },
  ]);
  expect(request.roles()).toContain("assistant");

  // Tools: the declared tool rides the request (name is
  // provider-encoded, so match on the stable suffix) -- this is the
  // direct CL-6448 regression shape (`tools: []` reaching the model).
  expect(request.tools.length).toBe(1);
  expect(request.toolNames()[0]).toContain("echo");
});
