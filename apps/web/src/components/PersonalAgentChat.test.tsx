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
  useMyraThreads: () => ({
    data:
      threads === undefined ? undefined : { threads, total: threads.length },
  }),
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
  DOCKED_BAR_TOTAL_HEIGHT: "calc(clamp(360px, 58vh, 760px) + 18px)",
}));
mock.module("./MyraChatSurface", () => ({
  MyraChatSurface: (props: {
    onUserSend?: (t: string) => void;
    onToggleExpand?: () => void;
    headerLeft?: React.ReactNode;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "surface" },
      // The switcher now rides in the panel header via headerLeft.
      props.headerLeft,
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
// The popup workflow strip owns its data fetching and has dedicated tests
// (WorkflowDock.popup.test.tsx); stub it here so this test needs no
// QueryClientProvider or api mock, and assert the wiring it receives.
mock.module("./WorkflowDock", () => ({
  WorkflowDock: (props: { conversationId: string | null; variant?: string }) =>
    React.createElement("div", {
      "data-testid": "popup-workflow-dock",
      "data-conversation-id": props.conversationId ?? "",
      "data-variant": props.variant ?? "",
    }),
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
    screen.getByTestId("expanded-overlay");

    fireEvent.click(screen.getByRole("button", { name: "minimize" }));
    expect(screen.queryByTestId("expanded-overlay")).toBeNull();
    screen.getByTestId("surface");
  });

  it("mounts the popup workflow strip wired to the active thread's conversation id", () => {
    renderAt("/artifacts/art-1");
    const dock = screen.getByTestId("popup-workflow-dock");
    expect(dock.getAttribute("data-variant")).toBe("popup");
    // Active thread defaults to the first thread when none is selected.
    expect(dock.getAttribute("data-conversation-id")).toBe("thr-other");
  });

  it("carries the workflow strip into the expanded overlay layout", () => {
    renderAt("/artifacts/art-1");
    fireEvent.click(screen.getByRole("button", { name: "expand" }));
    const overlay = screen.getByTestId("expanded-overlay");
    expect(
      overlay.querySelector('[data-testid="popup-workflow-dock"]'),
    ).not.toBeNull();
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
