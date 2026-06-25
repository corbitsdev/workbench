/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const renameMutate = mock((_args: { id: string; label: string }) => {});
const deleteMutate = mock((_id: string) => {});

mock.module("../../hooks/use-myra-threads", () => ({
  useMyraThreads: () => ({
    data: [
      {
        id: "t1",
        instanceId: "i1",
        label: "First",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "t2",
        instanceId: "i2",
        label: "Second",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
    isLoading: false,
  }),
  useRenameMyraThread: () => ({ mutate: renameMutate, isPending: false }),
  useDeleteMyraThread: () => ({ mutate: deleteMutate, isPending: false }),
  writeLastActiveThreadId: () => {},
}));

const { ThreadList } = require("./ThreadList");

beforeEach(() => {
  renameMutate.mockClear();
  deleteMutate.mockClear();
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
    expect(screen.getByText("First")).toBeDefined();
    expect(screen.getByText("Second")).toBeDefined();
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
