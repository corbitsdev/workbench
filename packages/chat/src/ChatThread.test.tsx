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
    expect(screen.getByTestId("busy-indicator")).toBeDefined();
    expect(screen.getByText("Ada is typing")).toBeDefined();
  });

  it("shows no busy indicator when idle", () => {
    render(<ChatThread messages={messages} agentName="Ada" />);
    expect(screen.queryByTestId("busy-indicator")).toBeNull();
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

  it("labels the busy indicator with the current activity", () => {
    render(
      <ChatThread
        messages={messages}
        activity={{ type: "thinking" }}
        agentName="Ada"
        typing
      />,
    );
    // One indicator, activity label wins over the generic typing label.
    expect(screen.getAllByTestId("busy-indicator")).toHaveLength(1);
    expect(screen.getByText("Ada is thinking")).toBeDefined();
  });

  it("still surfaces the activity label when no agentName is set", () => {
    render(<ChatThread messages={messages} activity={{ type: "thinking" }} />);
    expect(screen.getByText("Agent is thinking")).toBeDefined();
  });

  it("keeps the busy indicator visible while typing with no discrete activity", () => {
    render(<ChatThread messages={messages} typing agentName="Ada" />);
    expect(screen.getByTestId("busy-indicator")).toBeDefined();
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

  it("keeps quiet meta-tools generic on the activity pill", () => {
    render(
      <ChatThread
        messages={messages}
        agentName="Myra"
        activity={{ type: "tool_running", name: "search_tools" }}
        formatToolName={() => "Searching Workbench…"}
        isQuietTool={(name) => name === "search_tools"}
      />,
    );
    expect(screen.getByText("Myra is thinking")).toBeDefined();
    expect(screen.queryByText(/Searching Workbench/)).toBeNull();
    expect(screen.queryByText(/search_tools/)).toBeNull();
  });

  it("runs the scroll handler against the new scroll position and keeps messages rendered", () => {
    render(<ChatThread messages={messages} />);
    const log = screen.getByRole("log", { name: "Chat messages" });
    fireEvent.scroll(log, { target: { scrollTop: 40 } });
    expect(log.scrollTop).toBe(40);
    screen.getByText("Hello");
    screen.getByText("Hi back");
  });

  it("interleaves host inserts into the thread by timestamp", () => {
    render(
      <ChatThread
        messages={messages}
        inserts={[
          {
            id: "evt-1",
            at: "2026-06-04T00:00:30Z",
            node: <div data-testid="evt">between</div>,
          },
        ]}
      />,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    // The insert sits after "Hello" (00:00:00) and before "Hi back" (00:01:00).
    const order = log.textContent ?? "";
    expect(screen.getByTestId("evt")).toBeDefined();
    expect(order.indexOf("Hello")).toBeLessThan(order.indexOf("between"));
    expect(order.indexOf("between")).toBeLessThan(order.indexOf("Hi back"));
  });
});
