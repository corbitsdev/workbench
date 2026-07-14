/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router";

type ThreadItem = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
  lastActivityAt: string;
};
type ThreadsResult = {
  data?: { threads: ThreadItem[]; total: number };
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

let threadsResult: ThreadsResult = {
  data: {
    threads: [
      {
        id: "t1",
        instanceId: "i1",
        label: "First",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ],
    total: 1,
  },
  isLoading: false,
  isError: false,
  refetch: () => {},
};
const createMutate = mock((_arg: undefined, _opts?: unknown) => {});
const autoTitle = mock((_text: string) => {});
let autoTitleArgs: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: configurable session mock
let sessionResult: any = {
  state: { phase: "loading" },
  messages: [],
  activity: null,
};

mock.module("../hooks/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
mock.module("../hooks/use-myra-threads", () => ({
  useMyraThreads: () => threadsResult,
  useCreateMyraThread: () => ({ mutate: createMutate, isPending: false }),
  useAutoTitleFirstMessage: (...args: unknown[]) => {
    autoTitleArgs = args;
    return autoTitle;
  },
  writeLastActiveThreadId: () => {},
  resolveActiveThread: (threads: ThreadItem[], explicit?: string | null) => {
    if (!threads || threads.length === 0) return null;
    if (explicit) {
      const m = threads.find((t) => t.id === explicit);
      if (m) return m;
    }
    return threads[0];
  },
}));

mock.module("../hooks/use-myra-session", () => ({
  useMyraSession: () => sessionResult,
}));

mock.module("../components/MyraChatSurface", () => ({
  MyraChatSurface: (props: {
    threadLabel?: string;
    onUserSend?: (t: string) => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "surface" },
      React.createElement(
        "span",
        { "data-testid": "label" },
        props.threadLabel ?? "",
      ),
      React.createElement(
        "button",
        { onClick: () => props.onUserSend?.("hello") },
        "send",
      ),
    ),
}));

// The dock owns its data fetching and has dedicated tests (WorkflowDock.test.tsx);
// stub it here so the page test needs no QueryClientProvider or api mock.
mock.module("../components/WorkflowDock", () => ({
  WorkflowDock: (props: { conversationId: string | null }) =>
    React.createElement("div", {
      "data-testid": "workflow-dock",
      "data-conversation-id": props.conversationId ?? "",
    }),
}));

// Run-addressed workflow events derive from the shared conversation-runs query
// (WorkflowDock's hook); stub the derivation so the page test needs no
// QueryClientProvider — the derivation has its own tests (use-workflow-run-events).
mock.module("../hooks/use-workflow-run-events", () => ({
  useWorkflowRunEvents: () => [],
}));

mock.module("../components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// HITL gate routing (CL-2681) has its own tests (use-conversation-gates.test.tsx,
// MyraChatSurface.test.tsx); stub here so the page test needs no QueryClient.
mock.module("../hooks/use-conversation-gates", () => ({
  useConversationGates: () => ({ mode: "none" }),
}));

mock.module("../hooks/use-workflow", () => ({
  useResumeConversationGate: () => ({
    mutateAsync: () => Promise.resolve(),
  }),
}));

const { ChatThreadPage } = require("./ChatThreadPage");

function renderAt(path: string) {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: "/chats/:threadId",
          element: React.createElement(ChatThreadPage),
        }),
        React.createElement(Route, {
          path: "/chats",
          element: React.createElement(ChatThreadPage),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  createMutate.mockClear();
  autoTitle.mockClear();
  autoTitleArgs = [];
  sessionResult = { state: { phase: "loading" }, messages: [], activity: null };
  threadsResult = {
    data: {
      threads: [
        {
          id: "t1",
          instanceId: "i1",
          label: "First",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    },
    isLoading: false,
    isError: false,
    refetch: () => {},
  };
});

afterEach(() => cleanup());

describe("ChatThreadPage", () => {
  it("shows a loading state while threads load", () => {
    threadsResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: () => {},
    };
    renderAt("/chats/t1");
    screen.getByText(/loading your chats/i);
  });

  it("renders the chat surface and passes the Myra thread id as the dock's conversationId (conversationId == Myra thread id contract)", () => {
    renderAt("/chats/t1");
    expect(screen.getByTestId("label").textContent).toBe("First");
    // conversationId == Myra thread id; producers (workflow_start tool,
    // chat-initiated starts) stamp the same id as originConversationId — never
    // the instance id.
    expect(
      screen.getByTestId("workflow-dock").getAttribute("data-conversation-id"),
    ).toBe("t1");
  });

  it("shows a not-found state for an unknown thread id", () => {
    renderAt("/chats/unknown");
    screen.getByText(/this chat couldn't be found/i);
    expect(
      screen.getByRole("link", { name: /back to all chats/i }).getAttribute("href"),
    ).toBe("/chats");
    expect(screen.queryByTestId("surface")).toBeNull();
  });

  it("offers a create action when there are no threads", () => {
    threadsResult = {
      data: { threads: [], total: 0 },
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderAt("/chats");
    const button = screen.getByRole("button", { name: /start a chat/i });
    fireEvent.click(button);
    expect(createMutate).toHaveBeenCalledTimes(1);
  });

  it("wires the auto-title callback to the surface and binds it to the live thread", () => {
    sessionResult = {
      state: { phase: "ready", session: {} },
      messages: [{ role: "assistant" }],
      activity: null,
    };
    renderAt("/chats/t1");
    // The page binds the title hook to the resolved thread, then hands its
    // callback to the surface as onUserSend.
    expect(autoTitleArgs[0]).toMatchObject({ id: "t1" });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(autoTitle).toHaveBeenCalledWith("hello");
  });
});
