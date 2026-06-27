/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

type Thread = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
};

const sendSpy = mock((_text: string) => {});
const autoTitleSpy = mock((_text: string) => {});
let threads: Thread[];

mock.module("../lib/chat-launcher-context", () => ({
  useChatLauncher: () => ({
    hidden: false,
    registerReconnect: () => {},
    pendingMessage: null,
    clearPendingMessage: () => {},
  }),
}));
mock.module("../hooks/use-myra-session", () => ({
  useMyraSession: () => ({
    state: { phase: "ready" },
    messages: [],
    activity: null,
    send: sendSpy,
    reconnect: () => {},
    instanceId: "inst",
  }),
}));
mock.module("../hooks/use-myra-threads", () => ({
  useMyraThreads: () => ({ data: threads }),
  useCreateMyraThread: () => ({ mutate: () => {}, isPending: false }),
  useAutoTitleFirstMessage: () => autoTitleSpy,
  resolveActiveThread: (list: Thread[], id: string | null) =>
    list.find((t) => t.id === id) ?? list[0] ?? null,
  writeLastActiveThreadId: () => {},
}));
mock.module("@workbench/chat", () => ({
  ChatLauncher: () => React.createElement("div"),
  DockedChatBar: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "docked" }, children),
  FloatingChat: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "floating" }, children),
  DOCKED_BAR_HEIGHT: 340,
}));
mock.module("./MyraChatSurface", () => ({
  MyraChatSurface: (props: {
    onUserSend?: (t: string) => void;
    onToggleExpand?: () => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "surface" },
      React.createElement(
        "button",
        { onClick: () => props.onUserSend?.("typed in dock") },
        "send",
      ),
      React.createElement(
        "button",
        { onClick: () => props.onToggleExpand?.() },
        "expand",
      ),
    ),
  ExpandedChatOverlay: ({
    children,
    open,
    onExit,
  }: {
    children: React.ReactNode;
    open: boolean;
    onExit: () => void;
  }) =>
    open
      ? React.createElement(
          "div",
          { "data-testid": "expanded-overlay" },
          React.createElement("button", { onClick: onExit }, "minimize"),
          children,
        )
      : null,
}));
mock.module("./ThreadSwitcher", () => ({
  ThreadSwitcher: () =>
    React.createElement("div", { "data-testid": "thread-switcher" }),
}));

const { PersonalAgentChat } = require("./PersonalAgentChat");

function renderAt(pathname: string) {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      React.createElement(PersonalAgentChat),
    ),
  );
}

beforeEach(() => {
  sendSpy.mockClear();
  autoTitleSpy.mockClear();
  threads = [
    {
      id: "thr-other",
      instanceId: "inst-other",
      label: "Other",
      createdAt: "2026-01-01",
    },
    {
      id: "thr-target",
      instanceId: "inst-target",
      label: "Target",
      createdAt: "2026-01-02",
    },
  ];
});
afterEach(() => cleanup());

describe("PersonalAgentChat dock", () => {
  it("auto-titles when the user sends the first message via the dock surface", () => {
    // The bug being fixed: the dock surface must wire onUserSend so a typed
    // first message titles the thread, not just the programmatic handoff paths.
    renderAt("/artifacts/art-1");
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(autoTitleSpy).toHaveBeenCalledWith("typed in dock");
  });

  it("keeps the thread switcher and drops the inline popup when expanded", () => {
    renderAt("/artifacts/art-1");
    // Collapsed: the inline surface hosts the switcher; no overlay yet.
    expect(screen.queryByTestId("expanded-overlay")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "expand" }));

    // Expanded: the whole panel (switcher + surface) moves into the overlay and
    // neither the floating popup nor the docked bar is rendered behind it.
    const overlay = screen.getByTestId("expanded-overlay");
    expect(
      overlay.querySelector('[data-testid="thread-switcher"]'),
    ).not.toBeNull();
    expect(overlay.querySelector('[data-testid="surface"]')).not.toBeNull();
    expect(screen.queryByTestId("floating")).toBeNull();
    expect(screen.queryByTestId("docked")).toBeNull();
  });

  it("minimizing from the overlay returns to the inline surface, not closed", () => {
    renderAt("/artifacts/art-1");
    fireEvent.click(screen.getByRole("button", { name: "expand" }));
    expect(screen.getByTestId("expanded-overlay")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "minimize" }));
    expect(screen.queryByTestId("expanded-overlay")).toBeNull();
    expect(screen.getByTestId("surface")).toBeDefined();
  });

  it("renders nothing on the full-page chat route", () => {
    const { container } = render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/chats/thr-target"] },
        React.createElement(PersonalAgentChat),
      ),
    );
    expect(container.querySelector('[data-testid="surface"]')).toBeNull();
  });
});
