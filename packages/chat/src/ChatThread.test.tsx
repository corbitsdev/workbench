/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

mock.module("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          const {
            initial: _i,
            animate: _a,
            transition: _t,
            ...rest
          } = props as Record<string, unknown>;
          return React.createElement(tag, rest, children);
        },
    },
  ),
}));

import { ChatThread } from "./ChatThread";
import { type ChatMessage } from "./types";

const messages: ChatMessage[] = [
  {
    id: "1",
    role: "agent",
    content: "Hello",
    createdAt: "2026-06-04T00:00:00Z",
  },
  {
    id: "2",
    role: "user",
    content: "Hi back",
    createdAt: "2026-06-04T00:01:00Z",
  },
];

afterEach(() => {
  cleanup();
});

describe("ChatThread", () => {
  it("renders every message", () => {
    render(<ChatThread messages={messages} />);
    expect(screen.getByText("Hello")).toBeDefined();
    expect(screen.getByText("Hi back")).toBeDefined();
  });

  it("shows the default empty state with no messages and no activity", () => {
    render(<ChatThread messages={[]} />);
    expect(screen.getByText("Send a message to get started.")).toBeDefined();
  });

  it("renders a custom empty state when supplied", () => {
    render(<ChatThread messages={[]} emptyState={<p>Nothing here yet</p>} />);
    expect(screen.getByText("Nothing here yet")).toBeDefined();
    expect(screen.queryByText("Send a message to get started.")).toBeNull();
  });

  it("suppresses the empty state while typing", () => {
    render(<ChatThread messages={[]} typing typingLabel="Ada is typing" />);
    expect(screen.queryByText("Send a message to get started.")).toBeNull();
    expect(screen.getByTestId("typing-indicator")).toBeDefined();
    expect(screen.getByText("Ada is typing")).toBeDefined();
  });

  it("renders a tool narrative for agent messages with tool calls", () => {
    const withTools: ChatMessage[] = [
      {
        id: "t1",
        role: "agent",
        content: "Searching",
        createdAt: "2026-06-04T00:00:00Z",
        toolCalls: [{ id: "c1", name: "exa_search", result: "done" }],
      },
    ];
    render(
      <ChatThread
        messages={withTools}
        formatToolSummary={() => "searched the web"}
      />,
    );
    expect(screen.getByText("searched the web")).toBeDefined();
  });

  it("does not render a tool narrative when toolCalls is empty", () => {
    const noTools: ChatMessage[] = [
      {
        id: "t2",
        role: "agent",
        content: "Plain reply",
        createdAt: "2026-06-04T00:00:00Z",
        toolCalls: [],
      },
    ];
    render(
      <ChatThread
        messages={noTools}
        formatToolSummary={() => "should not appear"}
      />,
    );
    expect(screen.queryByText("should not appear")).toBeNull();
  });

  it("hides tool calls matched by hideToolCall but keeps the rest", () => {
    const mixed: ChatMessage[] = [
      {
        id: "t3",
        role: "agent",
        content: "Working",
        createdAt: "2026-06-04T00:00:00Z",
        toolCalls: [
          { id: "c1", name: "read_file", result: "mem" },
          { id: "c2", name: "exa_search", result: "done" },
        ],
      },
    ];
    render(
      <ChatThread
        messages={mixed}
        formatToolSummary={(call) => `ran ${call.name}`}
        hideToolCall={(call) => call.name === "read_file"}
      />,
    );
    expect(screen.queryByText("ran read_file")).toBeNull();
    expect(screen.getByText("ran exa_search")).toBeDefined();
  });

  it("renders no narrative when hideToolCall hides every call", () => {
    const allHidden: ChatMessage[] = [
      {
        id: "t4",
        role: "agent",
        content: "Bookkeeping",
        createdAt: "2026-06-04T00:00:00Z",
        toolCalls: [{ id: "c1", name: "read_file", result: "mem" }],
      },
    ];
    render(
      <ChatThread
        messages={allHidden}
        formatToolSummary={() => "should not appear"}
        hideToolCall={() => true}
      />,
    );
    expect(screen.queryByText("should not appear")).toBeNull();
  });

  it("shows an activity label instead of the typing indicator", () => {
    render(
      <ChatThread
        messages={messages}
        activity={{ type: "thinking" }}
        agentName="Ada"
        typing
      />,
    );
    expect(screen.queryByTestId("typing-indicator")).toBeNull();
    expect(screen.getByText("Ada is thinking")).toBeDefined();
  });

  it("formats each activity variant with the agent name", () => {
    const { rerender } = render(
      <ChatThread
        messages={messages}
        agentName="Ada"
        activity={{ type: "tool_call", name: "lookup" }}
      />,
    );
    expect(screen.getByText("Ada is calling Lookup")).toBeDefined();

    rerender(
      <ChatThread
        messages={messages}
        agentName="Ada"
        activity={{ type: "tool_running", name: "lookup" }}
      />,
    );
    expect(screen.getByText("Ada is running Lookup")).toBeDefined();

    rerender(
      <ChatThread
        messages={messages}
        agentName="Ada"
        activity={{ type: "rate_limited", retryAfterMs: 2200 }}
      />,
    );
    expect(
      screen.getByText("Ada is rate-limited, retrying in 3s"),
    ).toBeDefined();
  });

  it("does not render the activity pill when agentName is missing", () => {
    render(<ChatThread messages={messages} activity={{ type: "thinking" }} />);
    expect(screen.queryByText(/is thinking/)).toBeNull();
  });

  it("runs the scroll handler against the new scroll position and keeps messages rendered", () => {
    render(<ChatThread messages={messages} />);
    const log = screen.getByRole("log", { name: "Chat messages" });
    fireEvent.scroll(log, { target: { scrollTop: 40 } });
    expect(log.scrollTop).toBe(40);
    screen.getByText("Hello");
    screen.getByText("Hi back");
  });
});
