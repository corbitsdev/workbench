import { describe, expect, it } from "bun:test";
import type { InstanceEvent } from "@intx/hub-client";
import { convertInstanceEvents } from "./adapter";

describe("convertInstanceEvents", () => {
  it("converts a mail event with role user to a ChatMessage", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "msg-1",
        role: "user",
        content: "Hello Myra",
        sender: { name: "Alice", email: "alice@example.com" },
        recipients: [{ name: "Myra", email: "myra@workbench.example" }],
        timestamp: "2024-01-01T00:00:00.000Z",
        attachments: [],
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.id).toBe("msg-1");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello Myra");
    expect(msg.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("carries mail attachments onto the ChatMessage, deriving a name for null-named blobs", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "msg-att",
        role: "user",
        content: "See attached",
        sender: { name: "Alice", email: "alice@example.com" },
        recipients: [{ name: "Myra", email: "myra@workbench.example" }],
        timestamp: "2024-01-01T00:00:00.000Z",
        attachments: [
          {
            blobId: "blob-1",
            name: "report.pdf",
            type: "application/pdf",
            size: 2048,
          },
          { blobId: "blob-2", name: null, type: "image/png", size: 512 },
        ],
      },
    ];

    const messages = convertInstanceEvents(events);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.attachments).toEqual([
      {
        blobId: "blob-1",
        name: "report.pdf",
        type: "application/pdf",
        size: 2048,
      },
      { blobId: "blob-2", name: "Attachment", type: "image/png", size: 512 },
    ]);
  });

  it("omits attachments when the mail carried none", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "msg-none",
        role: "user",
        content: "no files",
        sender: { name: "Alice", email: "alice@example.com" },
        recipients: [{ name: "Myra", email: "myra@workbench.example" }],
        timestamp: "2024-01-01T00:00:00.000Z",
        attachments: [],
      },
    ];

    const msg = convertInstanceEvents(events)[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.attachments).toBeUndefined();
  });

  it("converts a mail event with role assistant to a ChatMessage with agent role", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "msg-2",
        role: "assistant",
        content: "Hello, how can I help?",
        sender: { name: "Myra", email: "myra@workbench.example" },
        recipients: [{ name: "Alice", email: "alice@example.com" }],
        timestamp: "2024-01-01T00:01:00.000Z",
        attachments: [],
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.role).toBe("agent");
  });

  it("converts a turn event to a ChatMessage with agent role", () => {
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "turn-1",
        content: "Processing your request.",
        timestamp: "2024-01-01T00:02:00.000Z",
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.id).toBe("turn-1");
    expect(msg.role).toBe("agent");
    expect(msg.content).toBe("Processing your request.");
    expect(msg.createdAt).toBe("2024-01-01T00:02:00.000Z");
  });

  it("maps tool calls on turn events", () => {
    // Upstream `InstanceEvent` (hub-client) dropped `reasoning` from the turn
    // variant with the session-runtime retirement, so a reloaded turn no longer
    // carries a persisted reasoning trace — only live streaming does.
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "turn-reload",
        content: "Here is the answer.",
        timestamp: "2024-01-01T00:02:00.000Z",
        toolCalls: [
          {
            name: "grep",
            arguments: { pattern: "foo" },
            result: "match",
            isError: false,
          },
        ],
      },
    ];

    const msg = convertInstanceEvents(events)[0];
    expect(msg?.reasoning).toBeUndefined();
    expect(msg?.toolCalls?.[0]?.name).toBe("grep");
  });

  it("marks mail events with isError as failed", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "msg-3",
        role: "assistant",
        content: "Error occurred",
        sender: { name: "Myra", email: "myra@workbench.example" },
        recipients: [],
        timestamp: "2024-01-01T00:03:00.000Z",
        attachments: [],
        isError: true,
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages[0]?.status).toBe("failed");
  });

  it("marks turn events with isError as failed", () => {
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "turn-2",
        content: "Inference failed",
        timestamp: "2024-01-01T00:04:00.000Z",
        isError: true,
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages[0]?.status).toBe("failed");
  });

  it("converts multiple events preserving order", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "a",
        role: "user",
        content: "First",
        sender: { name: null, email: "u@example.com" },
        recipients: [],
        timestamp: "2024-01-01T00:00:00.000Z",
        attachments: [],
      },
      {
        kind: "turn",
        turnId: "b",
        content: "Second",
        timestamp: "2024-01-01T00:01:00.000Z",
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe("a");
    expect(messages[1]?.id).toBe("b");
  });

  it("preserves input order — sorting is the hub-client session responsibility", () => {
    // The hub-client sorts events during hydration. convertInstanceEvents
    // intentionally preserves insertion order so that live SSE turn events
    // (which carry client-side timestamps) are not reordered relative to
    // concurrently-received user mails with server-side timestamps.
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "turn-2",
        content: "Second",
        timestamp: "2024-01-01T00:01:00.000Z",
      },
      {
        kind: "mail",
        id: "msg-1",
        role: "user",
        content: "First",
        sender: { name: null, email: "u@example.com" },
        recipients: [],
        timestamp: "2024-01-01T00:00:00.000Z",
        attachments: [],
      },
    ];

    const messages = convertInstanceEvents(events);

    expect(messages).toHaveLength(2);
    // Input order preserved — turn-2 was first in the array
    expect(messages[0]?.id).toBe("turn-2");
    expect(messages[1]?.id).toBe("msg-1");
  });

  it("returns empty array for empty input", () => {
    expect(convertInstanceEvents([])).toEqual([]);
  });

  it("populates senderLabel from an agent instance email address for inbound mail", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "mail-agent",
        role: "user",
        content: "Please handle this task",
        sender: { name: null, email: "ins_myra123@workbench.example" },
        recipients: [{ name: null, email: "ins_oat456@workbench.example" }],
        attachments: [],
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.senderLabel).toBe("ins_myra123");
  });

  it("populates senderLabel with display name when sender has a non-null name", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "mail-named",
        role: "user",
        content: "Hi",
        sender: { name: "Myra", email: "ins_myra123@workbench.example" },
        recipients: [],
        attachments: [],
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.senderLabel).toBe("Myra");
  });

  it("falls back to email local part when sender name is whitespace only", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "mail-ws",
        role: "user",
        content: "Hi",
        sender: { name: "   ", email: "ins_myra123@workbench.example" },
        recipients: [],
        attachments: [],
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.senderLabel).toBe("ins_myra123");
  });

  it("renders inbound mail with role agent so it is left-aligned", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "mail-role",
        role: "user",
        content: "Task for you",
        sender: { name: "Myra", email: "ins_myra@workbench.example" },
        recipients: [],
        attachments: [],
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.role).toBe("agent");
  });

  it("does not set senderLabel for outbound assistant mail", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "mail-out",
        role: "assistant",
        content: "Task complete",
        sender: { name: null, email: "ins_oat456@workbench.example" },
        recipients: [{ name: null, email: "ins_myra123@workbench.example" }],
        attachments: [],
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.senderLabel).toBeUndefined();
  });

  it("does not set senderLabel for turn events", () => {
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "turn-x",
        content: "Response",
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.senderLabel).toBeUndefined();
  });

  it("strips leading <context> block from user mail content", () => {
    const events: InstanceEvent[] = [
      {
        kind: "mail",
        id: "mail-1",
        role: "user",
        content:
          "<context>\nDate: 5/6/2026\nHuman Operator: Sawyer\n</context>\n\nHello Myra",
        sender: { name: "Sawyer", email: "sawyer@example.com" },
        recipients: [{ name: "Myra", email: "myra@workbench.example" }],
        attachments: [],
        timestamp: "2026-06-05T00:00:00Z",
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.content).toBe("Hello Myra");
  });
});

describe("convertInstanceEvents tool name resolution", () => {
  const rawCallId = "call_00_moYijX4P3EQ04w5R62pB3012";

  function turnWithTool(name: string): InstanceEvent[] {
    return [
      {
        kind: "turn",
        turnId: "turn-tool",
        content: "",
        timestamp: "2024-01-01T00:00:00.000Z",
        toolCalls: [{ name, arguments: {}, result: "ok", isError: false }],
      },
    ];
  }

  it("resolves a raw call-ID tool name via the toolNames map", () => {
    const messages = convertInstanceEvents(
      turnWithTool(rawCallId),
      new Map([[rawCallId, "exa_search"]]),
    );
    expect(messages[0]?.toolCalls?.[0]?.name).toBe("exa_search");
  });

  it("leaves an already-readable tool name unchanged even when present in the map", () => {
    const messages = convertInstanceEvents(
      turnWithTool("exa_search"),
      new Map([["exa_search", "something_else"]]),
    );
    expect(messages[0]?.toolCalls?.[0]?.name).toBe("exa_search");
  });

  it("keeps the raw call ID when the map has no matching entry", () => {
    const messages = convertInstanceEvents(turnWithTool(rawCallId), new Map());
    expect(messages[0]?.toolCalls?.[0]?.name).toBe(rawCallId);
  });

  it("keeps the raw call ID when no map is provided", () => {
    const messages = convertInstanceEvents(turnWithTool(rawCallId));
    expect(messages[0]?.toolCalls?.[0]?.name).toBe(rawCallId);
  });

  it("passes tool arguments through to the ChatMessage", () => {
    const events: InstanceEvent[] = [
      {
        kind: "turn",
        turnId: "turn-args",
        content: "",
        timestamp: "2024-01-01T00:00:00.000Z",
        toolCalls: [
          {
            name: "exa_search",
            arguments: { query: "minimax m3", numResults: 5 },
            result: "ok",
            isError: false,
          },
        ],
      },
    ];
    const messages = convertInstanceEvents(events);
    expect(messages[0]?.toolCalls?.[0]?.arguments).toEqual({
      query: "minimax m3",
      numResults: 5,
    });
  });
});
