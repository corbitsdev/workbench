/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

type ThreadItem = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
  lastActivityAt: string;
};
let threadsResult: {
  data?: { threads: ThreadItem[]; total: number };
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
type MutateOpts = {
  onSuccess?: (result: unknown) => void;
  onError?: (error: unknown) => void;
};
let mutateOutcome: "noop" | "error" = "noop";
const createMutate = mock((_arg: undefined, opts?: MutateOpts) => {
  if (mutateOutcome === "error") opts?.onError?.(new Error("boom"));
});

mock.module("../hooks/use-myra-threads", () => ({
  useMyraThreads: () => threadsResult,
  useCreateMyraThread: () => ({ mutate: createMutate, isPending: false }),
  writeLastActiveThreadId: () => {},
  readLastActiveThreadId: () => null,
}));

const { ChatsListPage } = require("./ChatsListPage");

function renderPage() {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/chats"] },
      React.createElement(ChatsListPage),
    ),
  );
}

beforeEach(() => {
  createMutate.mockClear();
  mutateOutcome = "noop";
  threadsResult = {
    data: {
      threads: [
        {
          id: "t1",
          instanceId: "i1",
          label: "Pricing strategy",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "t2",
          instanceId: "i2",
          label: "Onboarding flow",
          createdAt: "2026-01-02T00:00:00Z",
          lastActivityAt: "2026-01-02T00:00:00Z",
        },
      ],
      total: 2,
    },
    isLoading: false,
    isError: false,
    refetch: () => {},
  };
});

afterEach(() => cleanup());

describe("ChatsListPage", () => {
  it("lists each chat as a clickable row", () => {
    renderPage();
    expect(
      screen.getByRole("button", { name: /pricing strategy/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /onboarding flow/i }),
    ).not.toBeNull();
  });

  it("renders a relative timestamp derived from lastActivityAt", () => {
    threadsResult = {
      data: {
        threads: [
          {
            id: "t1",
            instanceId: "i1",
            label: "Recent thread",
            createdAt: "2026-01-01T00:00:00Z",
            lastActivityAt: new Date(
              Date.now() - 2 * 60 * 60 * 1000,
            ).toISOString(),
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderPage();
    expect(screen.getByText("2h")).not.toBeNull();
  });

  it("orders by lastActivityAt, not createdAt", () => {
    const now = Date.now();
    threadsResult = {
      data: {
        threads: [
          {
            id: "old-active",
            instanceId: "i1",
            label: "Old but active",
            createdAt: "2020-01-01T00:00:00Z",
            lastActivityAt: new Date(now - 60 * 60 * 1000).toISOString(),
          },
          {
            id: "new-idle",
            instanceId: "i2",
            label: "New but idle",
            createdAt: new Date(now).toISOString(),
            lastActivityAt: "2020-02-01T00:00:00Z",
          },
        ],
        total: 2,
      },
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderPage();
    const active = screen.getByRole("button", { name: /old but active/i });
    const idle = screen.getByRole("button", { name: /new but idle/i });
    // The recently-active thread renders before the idle one despite being the
    // older by creation — creation order would put "New but idle" first.
    expect(
      active.compareDocumentPosition(idle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("filters by the search query", () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/search chats/i), {
      target: { value: "pricing" },
    });
    expect(
      screen.getByRole("button", { name: /pricing strategy/i }),
    ).not.toBeNull();
    expect(screen.queryByText("Onboarding flow")).toBeNull();
  });

  it("shows a no-results message when nothing matches", () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/search chats/i), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(/no chats match/i)).not.toBeNull();
  });

  it("renders skeleton rows while loading and no thread rows", () => {
    threadsResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: () => {},
    };
    renderPage();
    expect(screen.queryByText(/loading chats/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /new chat/i })).toBeNull();
  });

  it("shows a legible error state with a retry action", () => {
    threadsResult = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: () => {},
    };
    renderPage();
    expect(screen.getByText(/could not load chats/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
  });

  it("shows an empty state and creates a chat", () => {
    threadsResult = {
      data: { threads: [], total: 0 },
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderPage();
    expect(screen.getByText(/no chats yet/i)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(createMutate).toHaveBeenCalledTimes(1);
  });

  it("shows a legible message when new-chat creation fails", () => {
    mutateOutcome = "error";
    renderPage();
    expect(screen.queryByText(/could not start a new chat/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(
      screen.queryByText(/could not start a new chat\. try again\./i),
    ).not.toBeNull();
  });
});
