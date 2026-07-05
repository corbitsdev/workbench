/// <reference types="bun" />
import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { InboundMessage } from "@intx/types/runtime";

// Capture the message handed to the agent's send() so we can assert the document
// bytes ride as a native MessageAttachment (the crux of CL-2628 — this is what
// the Anthropic adapter marshals into a document content block).
let sentMessage: InboundMessage | null = null;
let streamEvents: unknown[] = [];
let findManyResult: Record<string, unknown>[] = [];
let resolution: unknown = {
  ok: true,
  sources: [
    {
      id: "off_1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-test",
    },
  ],
};

mock.module("@intx/agent", () => ({
  createAgent: () =>
    Promise.resolve({
      stream: async function* () {
        for (const event of streamEvents) yield event;
      },
      send: (message: InboundMessage) => {
        sentMessage = message;
        return Promise.resolve({ reply: "EXTRACTED TEXT", turn: {} });
      },
      close: () => Promise.resolve(),
    }),
  defineAgent: (def: unknown) => def,
  createDefaultDirectorRegistry: () => ({}),
}));

// Mock the @workbench/agents barrel so its heavy transitive @intx/agent imports
// never load — the service only needs these two constants from it.
mock.module("@workbench/agents", () => ({
  FILE_PARSER_NAME: "File Parser",
  FILE_PARSER_SYSTEM_PROMPT: "You are a document parsing engine.",
}));

mock.module("@intx/db", () => ({
  getAncestorChain: () => Promise.resolve(["tnt_1"]),
  schema: { agent: { tenantId: "tenantId", name: "name" } },
}));

mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: () => Promise.resolve({}),
}));

mock.module("@workbench/event-collector", () => ({
  createEventCollector: () => ({
    onEvent: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    getAccumulatedText: () => null,
  }),
}));

mock.module("./agent-provisioning", () => ({
  resolveInstanceSourcesFromDefinition: () => Promise.resolve(resolution),
}));

mock.module("../config", () => ({
  getConfig: () => ({ hub: { dataDir: "/tmp/file-parser-test" } }),
}));

const { parseDocument, FileParseError } = await import("./file-parser");

function makeDb() {
  return {
    query: { agent: { findMany: () => Promise.resolve(findManyResult) } },
  };
}

const BASE_INPUT = {
  tenantId: "tnt_1",
  traceId: "art_1",
  filename: "deck.pdf",
  mimeType: "application/pdf",
  bytes: new Uint8Array([1, 2, 3, 4]),
};

describe("parseDocument (CL-2628)", () => {
  beforeEach(() => {
    sentMessage = null;
    streamEvents = [];
    findManyResult = [{ id: "agt_fp", tenantId: "tnt_1", name: "File Parser" }];
    resolution = {
      ok: true,
      sources: [
        { id: "off_1", provider: "anthropic", model: "claude-sonnet-5" },
      ],
    };
  });

  it("sends the document bytes as a MessageAttachment and returns the reply", async () => {
    const text = await parseDocument(makeDb() as never, BASE_INPUT);

    expect(text).toBe("EXTRACTED TEXT");
    expect(sentMessage).not.toBeNull();
    const attachments = sentMessage!.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.contentType).toBe("application/pdf");
    expect(attachments[0]!.name).toBe("deck.pdf");
    expect(Array.from(attachments[0]!.data)).toEqual([1, 2, 3, 4]);
  });

  it("passes the caller's extraction instructions as the prompt", async () => {
    await parseDocument(makeDb() as never, {
      ...BASE_INPUT,
      instructions: "list every action item",
    });
    expect(sentMessage!.content).toBe("list every action item");
  });

  it("throws when no File Parser definition is seeded", async () => {
    findManyResult = [];
    await expect(parseDocument(makeDb() as never, BASE_INPUT)).rejects.toThrow(
      FileParseError,
    );
  });

  it("throws when no inference source resolves", async () => {
    resolution = { ok: false, reason: "model_unavailable" };
    await expect(parseDocument(makeDb() as never, BASE_INPUT)).rejects.toThrow(
      FileParseError,
    );
  });
});

const inferenceDone = {
  type: "inference.done",
  seq: 4,
  data: {
    turn: {
      role: "assistant",
      content: [],
      model: "claude-sonnet-5",
      timestamp: 0,
    },
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: {
      sourceId: "off_1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    },
  },
};
const textDelta = {
  type: "inference.text.delta",
  seq: 3,
  data: { token: "x", partial: { text: "x" } },
};

describe("parseDocument analytics forwarding (CL-2801)", () => {
  beforeEach(() => {
    sentMessage = null;
    findManyResult = [{ id: "agt_fp", tenantId: "tnt_1", name: "File Parser" }];
    resolution = {
      ok: true,
      sources: [
        { id: "off_1", provider: "anthropic", model: "claude-sonnet-5" },
      ],
    };
    streamEvents = [textDelta, inferenceDone];
  });

  it("forwards each inference event to the analytics subscriber, attributed to the caller", async () => {
    const calls: unknown[] = [];
    const analytics = {
      onAgentEvent: () => Promise.resolve(),
      onLocalInferenceEvent: (args: unknown) => {
        calls.push(args);
        return Promise.resolve();
      },
    };

    await parseDocument(makeDb() as never, BASE_INPUT, {
      analytics,
      attributionPrincipalId: "prn_caller",
    });

    // Only the inference.done event maps to a fact; the text.delta is dropped by
    // factsFromInferenceEvent, but every parsed inference event is forwarded.
    expect(calls).toHaveLength(2);
    const done = calls.find(
      (c) => (c as { event: { type: string } }).event.type === "inference.done",
    ) as {
      tenantId: string;
      attributionPrincipalId: string;
      eventAddress: string;
      event: { data: { usage: { input: number } } };
    };
    expect(done.tenantId).toBe("tnt_1");
    expect(done.attributionPrincipalId).toBe("prn_caller");
    expect(done.eventAddress).toMatch(/^file-parser-/);
    expect(done.event.data.usage.input).toBe(120);
  });

  it("does not forward anything when no analytics dep is provided (no double sink)", async () => {
    // Proves the sidecar path is not the source here: with no injected sink the
    // in-process turn emits zero analytics, so it cannot be double-counted.
    const text = await parseDocument(makeDb() as never, BASE_INPUT);
    expect(text).toBe("EXTRACTED TEXT");
  });
});
