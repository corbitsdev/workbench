/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";
import { setPendingFirstMessage } from "../lib/pending-first-message";

type Thread = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
};

const sendSpy = mock((_text: string) => {});
const clearPendingDockThread = mock(() => {});
let threads: Thread[];
let pendingDockThreadId: string | null;

mock.module("../lib/chat-launcher-context", () => ({
  useChatLauncher: () => ({
    hidden: false,
    registerReconnect: () => {},
    pendingMessage: null,
    clearPendingMessage: () => {},
    pendingDockThreadId,
    clearPendingDockThread,
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
  MyraChatSurface: () =>
    React.createElement("div", { "data-testid": "surface" }),
}));
mock.module("./ThreadSwitcher", () => ({
  ThreadSwitcher: () => React.createElement("div"),
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
  clearPendingDockThread.mockClear();
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
  pendingDockThreadId = null;
});
afterEach(() => cleanup());

describe("PersonalAgentChat dock handoff", () => {
  it("delivers a seeded first message to the handed-off thread exactly once", async () => {
    // A surface (e.g. the artifact panel) seeds a thread it never delivered, then
    // hands it to the dock before its own session was ready.
    setPendingFirstMessage("thr-target", "seeded question");
    pendingDockThreadId = "thr-target";

    renderAt("/artifacts/art-1");

    await waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith("seeded question"),
    );
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(clearPendingDockThread).toHaveBeenCalled();
  });

  it("does not send when there is no pending message for the active thread", async () => {
    pendingDockThreadId = "thr-target";
    renderAt("/artifacts/art-1");
    await waitFor(() => expect(clearPendingDockThread).toHaveBeenCalled());
    expect(sendSpy).not.toHaveBeenCalled();
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
