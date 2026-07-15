/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";

import { ChatThread } from "./ChatThread";
import type { ChatMessage } from "./types";

afterEach(() => {
  cleanup();
});

// A streaming parts-native bubble (as composeChatMessages builds it: parts
// present, flat toolCalls ABSENT) whose live tool part is one the host hides.
const streamingMessage: ChatMessage = {
  id: "m1",
  role: "agent",
  content: "",
  createdAt: new Date().toISOString(),
  status: "sending",
  reasoning: "thinking about files",
  parts: [
    { type: "reasoning", text: "thinking about files" },
    {
      type: "tool",
      toolCallId: "c1",
      toolName: "write_file",
      state: "pending",
    },
  ],
};

// A settled hydrated message where the hidden tool arrives via flat toolCalls
// (and lifted parts), the path hideToolCall was originally designed for.
const settledMessage: ChatMessage = {
  id: "m2",
  role: "agent",
  content: "done",
  createdAt: new Date().toISOString(),
  status: "sent",
  toolCalls: [{ id: "c1", name: "write_file", result: "ok", isError: false }],
  parts: [
    {
      type: "tool",
      toolCallId: "c1",
      toolName: "write_file",
      state: "output-available",
      output: "ok",
    },
    { type: "text", text: "done" },
  ],
};

describe("hideToolCall applies to tool parts on both paths", () => {
  it("settled: hidden tool does not render", () => {
    const r = render(
      <ChatThread
        messages={[settledMessage]}
        hideToolCall={(c) => c.name === "write_file"}
      />,
    );
    expect(r.container.textContent).not.toContain("write_file");
    expect(r.queryByTestId("activity-block")).toBeNull();
  });

  it("streaming parts-native: hidden tool does not leak into the activity block or the rolling label", () => {
    const r = render(
      <ChatThread
        messages={[streamingMessage]}
        hideToolCall={(c) => c.name === "write_file"}
      />,
    );
    // The reasoning part keeps the activity block alive, but the hidden tool
    // must be absent everywhere: no name in the label, no tool count.
    const text = r.container.textContent ?? "";
    expect(text).not.toContain("write_file");
    expect(r.queryByTestId("activity-count")).toBeNull();
  });

  it("streaming parts-native: a turn whose only activity is a hidden tool renders no activity block", () => {
    const onlyHiddenTool: ChatMessage = {
      id: "m3",
      role: "agent",
      content: "",
      createdAt: new Date().toISOString(),
      status: "sending",
      parts: [
        {
          type: "tool",
          toolCallId: "c1",
          toolName: "write_file",
          state: "pending",
        },
      ],
    };
    const r = render(
      <ChatThread
        messages={[onlyHiddenTool]}
        hideToolCall={(c) => c.name === "write_file"}
      />,
    );
    expect(r.queryByTestId("activity-block")).toBeNull();
    expect(r.container.textContent).not.toContain("write_file");
  });
});
