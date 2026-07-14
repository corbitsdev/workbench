import { describe, expect, test } from "bun:test";
import {
  ChatMessageSchema,
  FilePartSchema,
  PartSchema,
  ReasoningPartSchema,
  TextPartSchema,
  ToolPartSchema,
} from "./types";
import type { ChatMessage } from "./types";
import { liftToParts } from "./parts";

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    role: "agent",
    content: "",
    createdAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("part schemas round-trip", () => {
  test("text part validates and round-trips", () => {
    const part = { type: "text", text: "hello" } as const;
    expect(TextPartSchema(part)).toEqual(part);
    expect(PartSchema(part)).toEqual(part);
  });

  test("reasoning part validates and round-trips", () => {
    const part = { type: "reasoning", text: "thinking..." } as const;
    expect(ReasoningPartSchema(part)).toEqual(part);
    expect(PartSchema(part)).toEqual(part);
  });

  test("tool part validates in each state", () => {
    const pending = {
      type: "tool",
      toolCallId: "call-1",
      toolName: "search",
      state: "pending",
    } as const;
    expect(ToolPartSchema(pending)).toEqual(pending);

    const available = {
      type: "tool",
      toolCallId: "call-1",
      toolName: "search",
      state: "output-available",
      output: "results",
    } as const;
    expect(ToolPartSchema(available)).toEqual(available);

    const errored = {
      type: "tool",
      toolCallId: "call-1",
      toolName: "search",
      state: "output-error",
      errorText: "boom",
    } as const;
    expect(ToolPartSchema(errored)).toEqual(errored);
  });

  test("tool part rejects an unknown state", () => {
    const invalid = {
      type: "tool",
      toolCallId: "call-1",
      toolName: "search",
      state: "input-streaming",
    };
    expect(ToolPartSchema.allows(invalid)).toBe(false);
  });

  test("file part validates for a blob reference and an inline data URI", () => {
    const attachmentFile = {
      type: "file",
      mediaType: "application/pdf",
      url: "blob:blob-1",
      filename: "notes.pdf",
      blobId: "blob-1",
      size: 1024,
    } as const;
    expect(FilePartSchema(attachmentFile)).toEqual(attachmentFile);

    const imageFile = {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,AAAA",
    } as const;
    expect(FilePartSchema(imageFile)).toEqual(imageFile);
  });

  test("ChatMessage accepts an optional parts array", () => {
    const message = baseMessage({
      parts: [{ type: "text", text: "hi" }],
    });
    expect(ChatMessageSchema(message)).toEqual(message);
  });

  test("ChatMessage without parts still validates", () => {
    const message = baseMessage({ content: "hi" });
    expect(ChatMessageSchema(message)).toEqual(message);
  });
});

describe("liftToParts determinism and totality", () => {
  test("empty message lifts to an empty parts array", () => {
    const message = baseMessage();
    expect(liftToParts(message)).toEqual([]);
  });

  test("text-only message lifts to a single text part", () => {
    const message = baseMessage({ content: "hello there" });
    expect(liftToParts(message)).toEqual([
      { type: "text", text: "hello there" },
    ]);
  });

  test("reasoning-only message lifts to a single reasoning part", () => {
    const message = baseMessage({ reasoning: "pondering" });
    expect(liftToParts(message)).toEqual([
      { type: "reasoning", text: "pondering" },
    ]);
  });

  test("empty reasoning string is omitted, not lifted as a blank part", () => {
    const message = baseMessage({ reasoning: "   ", content: "answer" });
    expect(liftToParts(message)).toEqual([{ type: "text", text: "answer" }]);
  });

  test("empty content string is omitted, not lifted as a blank text part", () => {
    const message = baseMessage({ content: "   ", reasoning: "thinking" });
    expect(liftToParts(message)).toEqual([
      { type: "reasoning", text: "thinking" },
    ]);
  });

  test("tool calls lift to tool parts in array order, mapping state from result/isError", () => {
    const message = baseMessage({
      content: "done",
      toolCalls: [
        { id: "call-1", name: "search", arguments: { q: "x" } },
        { id: "call-2", name: "fetch", result: "ok", isError: false },
        { id: "call-3", name: "write", result: "failed", isError: true },
      ],
    });
    expect(liftToParts(message)).toEqual([
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "search",
        state: "pending",
        input: { q: "x" },
      },
      {
        type: "tool",
        toolCallId: "call-2",
        toolName: "fetch",
        state: "output-available",
        output: "ok",
      },
      {
        type: "tool",
        toolCallId: "call-3",
        toolName: "write",
        state: "output-error",
        errorText: "failed",
      },
      { type: "text", text: "done" },
    ]);
  });

  test("tool call label is preserved when present", () => {
    const message = baseMessage({
      toolCalls: [{ id: "call-1", name: "search", label: "Searching the web" }],
    });
    expect(liftToParts(message)).toEqual([
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "search",
        state: "pending",
        label: "Searching the web",
      },
    ]);
  });

  test("attachments lift to file parts with a blob: url reference", () => {
    const message = baseMessage({
      attachments: [
        {
          blobId: "blob-1",
          name: "notes.pdf",
          type: "application/pdf",
          size: 512,
        },
      ],
    });
    expect(liftToParts(message)).toEqual([
      {
        type: "file",
        mediaType: "application/pdf",
        url: "blob:blob-1",
        filename: "notes.pdf",
        blobId: "blob-1",
        size: 512,
      },
    ]);
  });

  test("images lift to file parts with an inline data: url", () => {
    const message = baseMessage({
      images: [{ mimeType: "image/png", data: "AAAA" }],
    });
    expect(liftToParts(message)).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,AAAA",
      },
    ]);
  });

  test("hydrated-tier layout order: reasoning, then tools in array order, then attachments, then images, then text", () => {
    const message = baseMessage({
      content: "final answer",
      reasoning: "first I thought",
      toolCalls: [{ id: "call-1", name: "search" }],
      attachments: [
        { blobId: "blob-1", name: "a.pdf", type: "application/pdf", size: 1 },
      ],
      images: [{ mimeType: "image/png", data: "AAAA" }],
    });
    const parts = liftToParts(message);
    expect(parts.map((p) => p.type)).toEqual([
      "reasoning",
      "tool",
      "file",
      "file",
      "text",
    ]);
    expect(parts[3]).toEqual({
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,AAAA",
    });
  });

  test("lift never throws for any valid ChatMessage field combination", () => {
    const combos: ChatMessage[] = [
      baseMessage(),
      baseMessage({ content: "x" }),
      baseMessage({ reasoning: "x" }),
      baseMessage({ toolCalls: [] }),
      baseMessage({ attachments: [] }),
      baseMessage({ images: [] }),
      baseMessage({
        content: "x",
        reasoning: "y",
        toolCalls: [{ id: "c1", name: "n" }],
        attachments: [{ blobId: "b1", name: "n", type: "t", size: 1 }],
        images: [{ mimeType: "image/png", data: "d" }],
      }),
    ];
    for (const message of combos) {
      expect(() => liftToParts(message)).not.toThrow();
    }
  });

  test("every lifted part validates against PartSchema", () => {
    const message = baseMessage({
      content: "  padded answer  ",
      reasoning: "  think  ",
      toolCalls: [
        { id: "c1", name: "a" },
        { id: "c2", name: "b", result: "ok" },
        {
          id: "c3",
          name: "c",
          result: "bad",
          isError: true,
          label: "L",
          arguments: { x: 1 },
        },
      ],
      attachments: [{ blobId: "b1", name: "n", type: "t", size: 0 }],
      images: [{ mimeType: "image/png", data: "" }],
    });
    for (const part of liftToParts(message)) {
      expect(PartSchema(part)).toEqual(part);
    }
  });

  test("reasoning and text parts are both lifted trimmed", () => {
    const parts = liftToParts(
      baseMessage({ content: "  hi  ", reasoning: "  think  " }),
    );
    expect(parts).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "hi" },
    ]);
  });
});
