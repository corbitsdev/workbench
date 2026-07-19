/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const renameMutate = mock((_args: { id: string; label: string }) => {});
const deleteMutate = mock((_id: string) => {});

function makeThread(n: number): {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
  lastActivityAt: string;
  firstMessageAt: string | null;
} {
  return {
    id: `t${n}`,
    instanceId: `i${n}`,
    label: n === 1 ? "First" : n === 2 ? "Second" : `Chat ${n}`,
    createdAt: `2026-01-0${n}T00:00:00Z`,
    lastActivityAt: `2026-01-0${n}T00:00:00Z`,
    firstMessageAt: `2026-01-0${n}T00:00:00Z`,
  };
}

let threadsData = [makeThread(1), makeThread(2)];
let totalCount = 2;

const useMyraThreadsSpy = mock(() => ({
  data: { threads: threadsData, total: totalCount },
  isLoading: false,
}));

mock.module("../../hooks/use-myra-threads", () => ({
  useMyraThreads: useMyraThreadsSpy,
  useRenameMyraThread: () => ({ mutate: renameMutate, isPending: false }),
  useDeleteMyraThread: () => ({ mutate: deleteMutate, isPending: false }),
  writeLastActiveThreadId: () => {},
}));

const { ThreadList } = require("./ThreadList");
const {
  resetLocallyUsedMyraThreads,
  markMyraThreadUsedLocally,
} = require("../../hooks/myra-threads-cache");

beforeEach(() => {
  renameMutate.mockClear();
  deleteMutate.mockClear();
  useMyraThreadsSpy.mockClear();
  threadsData = [makeThread(1), makeThread(2)];
  totalCount = 2;
  resetLocallyUsedMyraThreads();
});

afterEach(() => cleanup());

function renderList(path = "/chats/t1") {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(ThreadList),
    ),
  );
}

describe("ThreadList", () => {
  it("lists the member threads", () => {
    renderList();
    screen.getByText("First");
    screen.getByText("Second");
  });

  it("shows no 'View all' link when below the sidebar limit", () => {
    renderList();
    expect(screen.queryByText(/view all chats/i)).toBeNull();
  });

  it("queries the thread list once, not once per row", () => {
    threadsData = Array.from({ length: 5 }, (_, i) => makeThread(i + 1));
    totalCount = 5;
    renderList();
    expect(useMyraThreadsSpy).toHaveBeenCalledTimes(1);
  });

  it("shows no 'View all' link when the total equals what's shown", () => {
    // Server returned all 10 and reports total 10: nothing hidden, no link.
    threadsData = Array.from({ length: 10 }, (_, i) => makeThread(i + 1));
    totalCount = 10;
    renderList();
    expect(screen.queryByText(/view all chats/i)).toBeNull();
  });

  it("links to /chats when the total exceeds the shown page", () => {
    // Server returned the 10-thread page but reports 15 total.
    threadsData = Array.from({ length: 10 }, (_, i) => makeThread(i + 1));
    totalCount = 15;
    renderList();
    const link = screen.getByText(/view all chats/i);
    expect(link.getAttribute("href")).toBe("/chats");
  });

  // CL-3749: a freshly created thread must not appear in the sidebar until its
  // first message is sent — "+ New chat" navigates but leaves the list alone.
  it("hides a thread that has no first message yet", () => {
    threadsData = [makeThread(1), { ...makeThread(2), firstMessageAt: null }];
    renderList();
    screen.getByText("First");
    expect(screen.queryByText("Second")).toBeNull();
  });

  it("shows an unused thread once this client marks it used locally", () => {
    threadsData = [makeThread(1), { ...makeThread(2), firstMessageAt: null }];
    markMyraThreadUsedLocally("i2");
    renderList();
    screen.getByText("Second");
  });

  it("shows the empty state when every thread is still unused", () => {
    threadsData = [
      { ...makeThread(1), firstMessageAt: null },
      { ...makeThread(2), firstMessageAt: null },
    ];
    renderList();
    screen.getByText(/no chats yet/i);
  });

  it("keeps the 'View all' link reachable when the page filters empty but more threads exist", () => {
    threadsData = Array.from({ length: 10 }, (_, i) => ({
      ...makeThread(i + 1),
      firstMessageAt: null,
    }));
    totalCount = 15;
    renderList();
    screen.getByText(/no chats yet/i);
    const link = screen.getByText(/view all chats/i);
    expect(link.getAttribute("href")).toBe("/chats");
  });

  it("renames a thread via the options menu", () => {
    renderList();
    const optionButtons = screen.getAllByRole("button", {
      name: /thread options/i,
    });
    fireEvent.click(optionButtons[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("First");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameMutate).toHaveBeenCalledTimes(1);
    expect(renameMutate.mock.calls[0]?.[0]).toEqual({
      id: "t1",
      label: "Renamed",
    });
  });

  it("does not rename when the label is unchanged", () => {
    renderList();
    const optionButtons = screen.getAllByRole("button", {
      name: /thread options/i,
    });
    fireEvent.click(optionButtons[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("First");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameMutate).not.toHaveBeenCalled();
  });

  it("deletes a thread from the options menu", () => {
    renderList();
    const optionButtons = screen.getAllByRole("button", {
      name: /thread options/i,
    });
    fireEvent.click(optionButtons[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0]?.[0]).toBe("t2");
  });
});
