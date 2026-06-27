/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

let threadsResult: {
  data?: { id: string; instanceId: string; label: string; createdAt: string }[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
type MutateOpts = {
  onSuccess?: (thread: { id: string }) => void;
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
    data: [
      {
        id: "t1",
        instanceId: "i1",
        label: "Pricing strategy",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "t2",
        instanceId: "i2",
        label: "Onboarding flow",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
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

  it("renders a relative timestamp derived from createdAt", () => {
    threadsResult = {
      data: [
        {
          id: "t1",
          instanceId: "i1",
          label: "Recent thread",
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
      ],
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
    renderPage();
    expect(screen.getByText("2h")).not.toBeNull();
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
      data: [],
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
