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

  it("leaves no orphan turn for a committed reasoning-only step in a live multi-step turn (CL-3752)", () => {
    const liveMultiStep: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "What changed this week?",
        createdAt: "2026-06-04T00:00:00Z",
        status: "sent",
      },
      {
        id: "a1",
        role: "agent",
        turnId: "g1",
        content: "",
        createdAt: "2026-06-04T00:00:01Z",
        status: "sent",
        reasoning: "Deciding what to check before answering.",
        parts: [
          {
            type: "reasoning",
            text: "Deciding what to check before answering.",
          },
        ],
      },
      {
        id: "a2",
        role: "agent",
        turnId: "g1",
        content: "Acme moved to contract.",
        createdAt: "2026-06-04T00:00:04Z",
        status: "sending",
        parts: [{ type: "text", text: "Acme moved to contract." }],
      },
    ];
    const { container } = render(
      <ChatThread messages={liveMultiStep} onRate={async () => {}} />,
    );
    // The committed reasoning-only segment projects to nothing; it must not
    // render its own (bubble-less, feedback-footer-only) agent turn, which
    // would reserve a large whitespace gap above the streaming answer.
    expect(
      container.querySelectorAll('[data-testid="agent-turn"]'),
    ).toHaveLength(1);
    expect(screen.getByText("Acme moved to contract.")).toBeDefined();
  });

  it("renders a tool narrative for a LIVE (still-streaming) agent turn with tool calls", () => {
    const withTools: ChatMessage[] = [
      {
        id: "t1",
        role: "agent",
        content: "Searching",
        createdAt: "2026-06-04T00:00:00Z",
        status: "sending",
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

  it("settled turn: drops the tool narrative and reasoning disclosure entirely, keeping only the answer", () => {
    const withTools: ChatMessage[] = [
      {
        id: "t1",
        role: "agent",
        content: "Searching",
        createdAt: "2026-06-04T00:00:00Z",
        reasoning: "Deciding which tool to call.",
        toolCalls: [{ id: "c1", name: "exa_search", result: "done" }],
      },
    ];
    render(
      <ChatThread
        messages={withTools}
        formatToolSummary={() => "searched the web"}
      />,
    );
    expect(screen.queryByTestId("activity-block")).toBeNull();
    expect(screen.queryByText("searched the web")).toBeNull();
    expect(screen.queryByText("Deciding which tool to call.")).toBeNull();
    expect(screen.getByText("Searching")).toBeDefined();
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

  it("hides tool calls matched by hideToolCall but keeps the rest, while the turn is live", () => {
    const mixed: ChatMessage[] = [
      {
        id: "t3",
        role: "agent",
        content: "Working",
        createdAt: "2026-06-04T00:00:00Z",
        status: "sending",
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

  describe("outputs-only settled multi-segment turns", () => {
    const multiSegment: ChatMessage[] = [
      {
        id: "seg1",
        role: "agent",
        content: "Let me look up what X refers to.",
        createdAt: "2026-06-04T00:00:10Z",
        turnId: "g1",
      },
      {
        id: "seg2",
        role: "agent",
        content: "Checked the records.",
        createdAt: "2026-06-04T00:00:20Z",
        turnId: "g1",
        toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
      },
      {
        id: "seg3",
        role: "agent",
        content: "Let me check memory.",
        createdAt: "2026-06-04T00:00:30Z",
        turnId: "g1",
        reasoning: "Cross-referencing with the call notes.",
      },
      {
        id: "seg4",
        role: "agent",
        content: "Here is the summary.",
        createdAt: "2026-06-04T00:00:40Z",
        turnId: "g1",
        feedbackId: "turn-4",
      },
    ];

    it("renders only the final answer + feedback for a settled multi-segment turn — no narration, tool chips, or reasoning", () => {
      render(
        <ChatThread
          messages={multiSegment}
          onRate={() => Promise.resolve()}
          getRating={() => null}
        />,
      );
      expect(screen.getByText("Here is the summary.")).toBeDefined();
      expect(screen.queryByText("Let me look up what X refers to.")).toBeNull();
      expect(screen.queryByText("Checked the records.")).toBeNull();
      expect(screen.queryByText("Let me check memory.")).toBeNull();
      expect(
        screen.queryByText("Cross-referencing with the call notes."),
      ).toBeNull();
      expect(screen.queryByTestId("activity-block")).toBeNull();
      expect(screen.getAllByRole("button", { name: "Thumbs up" })).toHaveLength(
        1,
      );
    });

    it("renders exactly one agent turn for the whole settled group", () => {
      render(<ChatThread messages={multiSegment} />);
      expect(screen.getAllByTestId("agent-turn")).toHaveLength(1);
    });

    it("carries forward files produced by any segment of a settled multi-segment turn", () => {
      const withFile: ChatMessage[] = [
        {
          id: "seg1",
          role: "agent",
          content: "Generating the deck.",
          createdAt: "2026-06-04T00:00:10Z",
          turnId: "gf",
          attachments: [
            {
              blobId: "b1",
              name: "deck.pdf",
              type: "application/pdf",
              size: 100,
            },
          ],
        },
        {
          id: "seg2",
          role: "agent",
          content: "Done — here it is.",
          createdAt: "2026-06-04T00:00:20Z",
          turnId: "gf",
        },
      ];
      render(
        <ChatThread
          messages={withFile}
          resolveAttachmentUrl={() => Promise.resolve("blob:resolved")}
        />,
      );
      expect(screen.getByText("Done — here it is.")).toBeDefined();
      expect(screen.getByTitle("Download deck.pdf")).toBeDefined();
    });

    it("keeps live-turn rendering unchanged: an in-progress multi-segment turn still shows each committed segment plus the rolling activity line", () => {
      const live: ChatMessage[] = [
        {
          id: "seg1",
          role: "agent",
          content: "Let me look up what X refers to.",
          createdAt: "2026-06-04T00:00:10Z",
          turnId: "gl",
        },
        {
          id: "seg2",
          role: "agent",
          content: "",
          createdAt: "2026-06-04T00:00:20Z",
          status: "sending",
          turnId: "gl",
          toolCalls: [{ id: "c1", name: "crm_lookup" }],
        },
      ];
      render(
        <ChatThread messages={live} formatToolSummary={() => "Looked up"} />,
      );
      expect(
        screen.getByText("Let me look up what X refers to."),
      ).toBeDefined();
      expect(screen.getAllByTestId("agent-turn")).toHaveLength(2);
    });

    it("reload parity: a settled turn hydrated fresh (lifted parts) renders identically to the same turn projected live-settled", () => {
      const first = render(<ChatThread messages={multiSegment} />);
      const html = first.container.innerHTML;
      cleanup();
      // Simulate a hard reload: same settled messages, freshly rendered.
      const second = render(<ChatThread messages={[...multiSegment]} />);
      expect(second.container.innerHTML).toBe(html);
    });

    describe("CL-3734: live-turn per-segment projection", () => {
      const liveThreeSegments: ChatMessage[] = [
        {
          id: "seg1",
          role: "agent",
          content: "Let me look up what X refers to.",
          createdAt: "2026-06-04T00:00:10Z",
          turnId: "gl",
          reasoning: "Deciding how to look this up.",
        },
        {
          id: "seg2",
          role: "agent",
          content: "Checked the records.",
          createdAt: "2026-06-04T00:00:20Z",
          turnId: "gl",
          toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
        },
        {
          id: "seg3",
          role: "agent",
          content: "",
          createdAt: "2026-06-04T00:00:30Z",
          status: "sending",
          turnId: "gl",
          toolCalls: [{ id: "c2", name: "memory_search" }],
        },
      ];

      it("shows exactly one activity element for a live group with two settled segments and one streaming", () => {
        render(
          <ChatThread
            messages={liveThreeSegments}
            formatToolSummary={() => "searched memory"}
          />,
        );
        expect(screen.getAllByTestId("activity-block")).toHaveLength(1);
      });

      it("renders the settled segments' carried text but no reasoning or tool rows", () => {
        render(
          <ChatThread
            messages={liveThreeSegments}
            formatToolSummary={() => "searched memory"}
          />,
        );
        expect(
          screen.getByText("Let me look up what X refers to."),
        ).toBeDefined();
        expect(screen.getByText("Checked the records.")).toBeDefined();
        expect(screen.queryByText("Deciding how to look this up.")).toBeNull();
        expect(screen.queryByText("crm_lookup")).toBeNull();
      });

      it("renders the streaming segment's activity through the single activity block", () => {
        render(
          <ChatThread
            messages={liveThreeSegments}
            formatToolSummary={() => "searched memory"}
          />,
        );
        expect(screen.getByText("searched memory")).toBeDefined();
      });

      it("CL-3751: a live multi-segment turn shows zero feedback footers, even with onRate/getRating wired", () => {
        render(
          <ChatThread
            messages={liveThreeSegments}
            formatToolSummary={() => "searched memory"}
            onRate={() => Promise.resolve()}
            getRating={() => null}
          />,
        );
        expect(screen.getAllByTestId("agent-turn")).toHaveLength(3);
        expect(screen.queryByRole("button", { name: "Thumbs up" })).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Thumbs down" }),
        ).toBeNull();
      });

      it("CL-3751: once the turn settles, exactly one feedback footer appears on the final output", () => {
        const settledGroup: ChatMessage[] = liveThreeSegments.map(
          (message, index) => {
            if (index !== liveThreeSegments.length - 1) return message;
            const { status: _status, ...rest } = message;
            return {
              ...rest,
              content: "Here is the final answer.",
              feedbackId: "turn-final",
            };
          },
        );
        render(
          <ChatThread
            messages={settledGroup}
            formatToolSummary={() => "searched memory"}
            onRate={() => Promise.resolve()}
            getRating={() => null}
          />,
        );
        expect(
          screen.getAllByRole("button", { name: "Thumbs up" }),
        ).toHaveLength(1);
      });

      describe("state matrix: exactly one animated indicator per live state, zero when settled", () => {
        function countIndicators() {
          return (
            screen.queryAllByTestId("busy-indicator").length +
            screen.queryAllByTestId("activity-block").length
          );
        }
        const user: ChatMessage = {
          id: "u1",
          role: "user",
          content: "question",
          createdAt: "2026-06-04T00:00:00Z",
        };

        it("optimistic pre-event (typing, no live signal yet): the busy pill is the one indicator", () => {
          render(<ChatThread messages={[user]} typing agentName="Ada" />);
          expect(screen.getAllByTestId("busy-indicator")).toHaveLength(1);
          expect(countIndicators()).toBe(1);
        });

        it("optimistic pre-event with a bare sending shell (no parts, no text): the pill stays up — never zero indicators", () => {
          const shell: ChatMessage = {
            id: "a1",
            role: "agent",
            content: "",
            createdAt: "2026-06-04T00:00:10Z",
            status: "sending",
            turnId: "gm",
          };
          render(<ChatThread messages={[user, shell]} typing />);
          expect(screen.getAllByTestId("busy-indicator")).toHaveLength(1);
          expect(countIndicators()).toBe(1);
        });

        it("reasoning-only streaming: the turn's activity line is the one indicator; the pill is suppressed", () => {
          const reasoningOnly: ChatMessage = {
            id: "a1",
            role: "agent",
            content: "",
            createdAt: "2026-06-04T00:00:10Z",
            status: "sending",
            turnId: "gm",
            reasoning: "Working through it",
          };
          render(
            <ChatThread
              messages={[user, reasoningOnly]}
              typing
              activity={{ type: "thinking" }}
            />,
          );
          expect(screen.getAllByTestId("activity-block")).toHaveLength(1);
          expect(screen.queryByTestId("busy-indicator")).toBeNull();
          expect(countIndicators()).toBe(1);
        });

        it("tool-running: the turn's activity line is the one indicator; the pill is suppressed", () => {
          const toolRunning: ChatMessage = {
            id: "a1",
            role: "agent",
            content: "",
            createdAt: "2026-06-04T00:00:10Z",
            status: "sending",
            turnId: "gm",
            toolCalls: [{ id: "c1", name: "crm_lookup" }],
          };
          render(
            <ChatThread
              messages={[user, toolRunning]}
              typing
              activity={{ type: "tool_running", name: "crm_lookup" }}
              formatToolSummary={() => "looking that up"}
            />,
          );
          expect(screen.getAllByTestId("activity-block")).toHaveLength(1);
          expect(screen.queryByTestId("busy-indicator")).toBeNull();
          expect(countIndicators()).toBe(1);
        });

        it("text-streaming after tool activity: still exactly one indicator", () => {
          const textStreaming: ChatMessage = {
            id: "a1",
            role: "agent",
            content: "Here is a partial ans",
            createdAt: "2026-06-04T00:00:10Z",
            status: "sending",
            turnId: "gm",
            toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
          };
          render(<ChatThread messages={[user, textStreaming]} typing />);
          expect(screen.getByText("Here is a partial ans")).toBeDefined();
          expect(countIndicators()).toBe(1);
        });

        it("settled: zero animated indicators", () => {
          const settled: ChatMessage = {
            id: "a1",
            role: "agent",
            content: "Here is the answer.",
            createdAt: "2026-06-04T00:00:10Z",
            turnId: "gm",
            reasoning: "Worked through it",
            toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
          };
          render(<ChatThread messages={[user, settled]} />);
          expect(screen.getByText("Here is the answer.")).toBeDefined();
          expect(countIndicators()).toBe(0);
        });
      });

      it("suppresses the thread-level busy indicator while a trailing segment is already streaming its own activity block", () => {
        render(
          <ChatThread
            messages={liveThreeSegments}
            activity={{ type: "thinking" }}
            formatToolSummary={() => "searched memory"}
          />,
        );
        expect(screen.queryByTestId("busy-indicator")).toBeNull();
      });

      it("re-projects identically to a reload once the last segment settles (parity)", () => {
        const settled: ChatMessage[] = [
          liveThreeSegments[0]!,
          liveThreeSegments[1]!,
          {
            id: "seg3",
            role: "agent",
            content: "Here is the summary.",
            createdAt: "2026-06-04T00:00:30Z",
            turnId: "gl",
            toolCalls: [{ id: "c2", name: "memory_search", result: "ok" }],
          },
        ];
        const fromSettle = render(<ChatThread messages={settled} />);
        const settleHtml = fromSettle.container.innerHTML;
        cleanup();
        const fromReload = render(<ChatThread messages={[...settled]} />);
        expect(fromReload.container.innerHTML).toBe(settleHtml);
      });
    });

    it("renders the escape-hatch trace link when the host supplies getTurnTraceHref, pointing at the resolved href", () => {
      render(
        <ChatThread
          messages={multiSegment}
          getTurnTraceHref={() => "/insights"}
        />,
      );
      const link = screen.getByRole("link", { name: "View trace" });
      expect(link.getAttribute("href")).toBe("/insights");
    });

    it("omits the trace link when the host supplies no getTurnTraceHref", () => {
      render(<ChatThread messages={multiSegment} />);
      expect(screen.queryByRole("link", { name: "View trace" })).toBeNull();
    });

    it("never folds an agent-initiated mail into the prior turn: both the answer and the mail render, each with its own feedback", () => {
      // user Q -> multi-segment answer A1 -> agent-initiated mail M (gate
      // mail / brief) with NO user message between. M has no turnId; folding
      // it into the turn would drop A1's answer and re-anchor feedback.
      const thread: ChatMessage[] = [
        {
          id: "u1",
          role: "user",
          content: "question",
          createdAt: "2026-06-04T00:00:00Z",
        },
        {
          id: "a1",
          role: "agent",
          content: "Let me check.",
          createdAt: "2026-06-04T00:00:10Z",
          turnId: "g1",
          toolCalls: [{ id: "c1", name: "crm_lookup", result: "found" }],
        },
        {
          id: "a2",
          role: "agent",
          content: "The real answer.",
          createdAt: "2026-06-04T00:00:20Z",
          turnId: "g1",
        },
        {
          id: "m1",
          role: "agent",
          content: "Gate mail body.",
          createdAt: "2026-06-04T00:00:30Z",
        },
      ];
      render(
        <ChatThread
          messages={thread}
          onRate={() => Promise.resolve()}
          getRating={() => null}
        />,
      );
      expect(screen.getByText("The real answer.")).toBeDefined();
      expect(screen.getByText("Gate mail body.")).toBeDefined();
      expect(screen.queryByText("Let me check.")).toBeNull();
      expect(screen.getAllByRole("button", { name: "Thumbs up" })).toHaveLength(
        2,
      );
    });

    it("keeps a failed segment visible: a group containing a failed segment is not projection-stripped", () => {
      const thread: ChatMessage[] = [
        {
          id: "a1",
          role: "agent",
          content: "Let me check.",
          createdAt: "2026-06-04T00:00:10Z",
          turnId: "g1",
        },
        {
          id: "a2",
          role: "agent",
          content: "Something broke.",
          createdAt: "2026-06-04T00:00:20Z",
          turnId: "g1",
          status: "failed",
        },
      ];
      render(<ChatThread messages={thread} />);
      // The failed segment renders with its member-actionable error state,
      // and the group is not collapsed to a single projected answer.
      expect(screen.getByText("Something broke.")).toBeDefined();
      expect(screen.getByText("Let me check.")).toBeDefined();
      expect(screen.getByRole("alert").textContent).toContain("Failed to send");
    });

    it("carries an embedded UI block from a non-final segment through settle", () => {
      const blockContent = [
        "Here's the document.",
        "```ui",
        '{"kind":"document","title":"ABK Demo","source":"# Call"}',
        "```",
      ].join("\n");
      const thread: ChatMessage[] = [
        {
          id: "a1",
          role: "agent",
          content: blockContent,
          createdAt: "2026-06-04T00:00:10Z",
          turnId: "g1",
          toolCalls: [{ id: "c1", name: "doc_build", result: "ok" }],
        },
        {
          id: "a2",
          role: "agent",
          content: "Anything else?",
          createdAt: "2026-06-04T00:00:20Z",
          turnId: "g1",
        },
      ];
      render(<ChatThread messages={thread} />);
      expect(screen.getByText("Anything else?")).toBeDefined();
      expect(screen.getByText("Here's the document.")).toBeDefined();
      // Tool chrome is still gone even though the block segment survives.
      expect(screen.queryByTestId("activity-block")).toBeNull();
    });
  });
});
