/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// framer-motion is not compatible with Happy DOM; replace motion.* with plain elements.
mock.module("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          // Strip framer-only props that React would warn about.
          const {
            drag: _drag,
            dragMomentum: _dm,
            whileTap: _wt,
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

import { ChatPanel } from "./ChatPanel";
import { ChatLauncher } from "./ChatLauncher";
import {
  type ChatAgentIdentity,
  type ChatMessage,
  type QuickReply,
} from "./types";

const agent: ChatAgentIdentity = { name: "Ada", tagline: "Personal agent" };

const messages: ChatMessage[] = [
  {
    id: "1",
    role: "agent",
    content: "Hi, how can I help?",
    createdAt: "2026-06-04T00:00:00Z",
  },
  {
    id: "2",
    role: "user",
    content: "Draft an email",
    createdAt: "2026-06-04T00:01:00Z",
  },
];

afterEach(() => {
  cleanup();
});

describe("ChatPanel", () => {
  it("renders the thread of messages", () => {
    render(<ChatPanel agent={agent} messages={messages} onSend={() => {}} />);
    expect(screen.getByText("Hi, how can I help?")).toBeDefined();
    expect(screen.getByText("Draft an email")).toBeDefined();
  });

  it("fires onSend with the typed text and clears the input", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatPanel agent={agent} messages={messages} onSend={onSend} />);

    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    await user.type(input, "Hello Ada");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("Hello Ada");
    expect(input.value).toBe("");
  });

  it("does not fire onSend for an empty/whitespace draft", async () => {
    const user = userEvent.setup();
    const onSend = mock((_text: string) => {});
    render(<ChatPanel agent={agent} messages={messages} onSend={onSend} />);

    await user.type(screen.getByLabelText("Message"), "   ");
    // Send button is disabled, but enter should also no-op.
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the busy indicator when typing is true", () => {
    render(
      <ChatPanel agent={agent} messages={messages} onSend={() => {}} typing />,
    );
    expect(screen.getByTestId("busy-indicator")).toBeDefined();
    expect(screen.getByText("Ada is typing")).toBeDefined();
  });

  it("labels the busy indicator with the activity when one is present", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        activity={{ type: "thinking" }}
      />,
    );
    expect(screen.getAllByTestId("busy-indicator")).toHaveLength(1);
    expect(screen.getByText("Ada is thinking")).toBeDefined();
  });

  it("shows a tool-specific activity label when a tool call is in progress", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        activity={{ type: "tool_call", name: "exa_search" }}
      />,
    );
    expect(screen.getByText("Ada is calling Search")).toBeDefined();
  });

  it("shows a tool-running activity label when a tool is executing", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        activity={{ type: "tool_running", name: "exa_search" }}
      />,
    );
    expect(screen.getByText("Ada is running Search")).toBeDefined();
  });

  it("shows a rate-limited activity label with retry timing", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        activity={{ type: "rate_limited", retryAfterMs: 3500 }}
      />,
    );
    expect(
      screen.getByText("Ada is rate-limited, retrying in 4s"),
    ).toBeDefined();
  });

  it("fires onQuickReply when a chip is clicked", async () => {
    const user = userEvent.setup();
    const onQuickReply = mock((_reply: QuickReply) => {});
    const replies: QuickReply[] = [
      { id: "q1", label: "Summarize", value: "summarize please" },
    ];
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        quickReplies={replies}
        onQuickReply={onQuickReply}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Summarize" }));
    expect(onQuickReply).toHaveBeenCalledTimes(1);
    expect(onQuickReply.mock.calls[0]?.[0]?.value).toBe("summarize please");
  });

  it("toggles dock via the header control", async () => {
    const user = userEvent.setup();
    const onToggleDock = mock(() => {});
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        dockState="floating"
        onToggleDock={onToggleDock}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dock chat" }));
    expect(onToggleDock).toHaveBeenCalledTimes(1);
  });

  it("toggles expand via the header control in floating mode", async () => {
    const user = userEvent.setup();
    const onToggleExpand = mock(() => {});
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        dockState="floating"
        onToggleExpand={onToggleExpand}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand chat" }));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("shows Collapse and hides the expand control when docked", () => {
    const { rerender } = render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        dockState="floating"
        expanded
        onToggleExpand={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Collapse chat" })).toBeDefined();

    rerender(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        dockState="docked"
        onToggleExpand={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Expand chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse chat" })).toBeNull();
  });
});

describe("ChatPanel single merged header", () => {
  it("renders headerLeft and the dock/close controls in one bar, replacing the default identity", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        dockState="docked"
        onToggleDock={() => {}}
        onClose={() => {}}
        headerLeft={<div>Thread switcher</div>}
      />,
    );
    // The provided left slot and the right-side controls share the same header.
    expect(screen.getByText("Thread switcher")).toBeDefined();
    expect(screen.getByRole("button", { name: "Float chat" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Close chat" })).toBeDefined();
    // The default agent identity is not stacked as a second header.
    expect(screen.queryByText("Personal agent")).toBeNull();
  });

  it("still shows the default agent identity when no headerLeft is provided", () => {
    render(<ChatPanel agent={agent} messages={messages} onSend={() => {}} />);
    expect(screen.getByText("Ada")).toBeDefined();
    expect(screen.getByText("Personal agent")).toBeDefined();
  });
});

describe("ChatPanel composer width", () => {
  it("drops the centered max-width on the composer row when composerFullWidth is set", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        composerFullWidth
      />,
    );
    const row = screen.getByLabelText("Message").parentElement;
    expect(row?.className).not.toContain("max-w-[60vw]");
  });

  it("keeps the centered max-width on the composer row by default", () => {
    render(<ChatPanel agent={agent} messages={messages} onSend={() => {}} />);
    const row = screen.getByLabelText("Message").parentElement;
    expect(row?.className).toContain("max-w-[60vw]");
  });
});

describe("ChatPanel empty state", () => {
  it("shows default empty state when there are no messages", () => {
    render(<ChatPanel agent={agent} messages={[]} onSend={() => {}} />);
    expect(screen.getByText("Send a message to get started.")).toBeDefined();
  });

  it("does not show the empty state once messages exist", () => {
    render(<ChatPanel agent={agent} messages={messages} onSend={() => {}} />);
    expect(screen.queryByText("Send a message to get started.")).toBeNull();
  });
});

describe("ChatPanel busy state", () => {
  it("disables the Send button while the agent is thinking", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        activity={{ type: "thinking" }}
      />,
    );
    const sendButton = screen.getByRole("button", {
      name: "Waiting for agent",
    });
    expect(sendButton).toBeDefined();
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the Send button while typing indicator is active", () => {
    render(
      <ChatPanel agent={agent} messages={messages} onSend={() => {}} typing />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Waiting for agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the activity pill with the agent name while a tool is running", () => {
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={() => {}}
        activity={{ type: "tool_running", name: "draft_email" }}
      />,
    );
    expect(screen.getByText("Ada is running Draft email")).toBeDefined();
  });

  it("does not block Send after activity clears", () => {
    render(<ChatPanel agent={agent} messages={messages} onSend={() => {}} />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDefined();
  });
});

describe("ChatPanel composer interaction", () => {
  it("does not fire onSend when busy", async () => {
    const onSend = mock((_text: string) => {});
    render(
      <ChatPanel
        agent={agent}
        messages={messages}
        onSend={onSend}
        activity={{ type: "thinking" }}
      />,
    );
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ChatLauncher", () => {
  it("fires onClick when pressed", async () => {
    const user = userEvent.setup();
    const onClick = mock(() => {});
    render(<ChatLauncher onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Open chat" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders an unread badge when count is positive", () => {
    render(<ChatLauncher onClick={() => {}} unreadCount={3} />);
    expect(screen.getByText("3")).toBeDefined();
  });
});
