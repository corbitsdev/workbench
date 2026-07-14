/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

mock.module("../hooks/use-mailbox", () => ({
  useMailbox: () => ({ data: undefined }),
  useMailboxUnreadCount: () => ({ data: undefined }),
  MAILBOX_POLL_MS: 30_000,
}));
mock.module("../hooks/use-mailbox-live", () => ({
  useMailboxLive: () => {},
}));
mock.module("../hooks/use-tasks", () => ({
  useTasks: () => ({ data: undefined }),
}));

import { AppTopBar } from "./AppTopBar";
import { PageChromeProvider, useSetPageChrome } from "../lib/page-chrome";
import { ActiveContextProvider } from "../lib/active-context-store";

afterEach(cleanup);

function PageChromeSetter({ node }: { node: React.ReactNode }) {
  useSetPageChrome(node);
  return null;
}

function renderTopBar(chrome: React.ReactNode | null) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: React.createElement(
          ActiveContextProvider,
          null,
          React.createElement(
            PageChromeProvider,
            null,
            chrome
              ? React.createElement(PageChromeSetter, { node: chrome })
              : null,
            React.createElement(AppTopBar, { onOpenMenu: () => {} }),
          ),
        ),
      },
      {
        path: "/inbox",
        element: React.createElement("div", null, "Inbox"),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(React.createElement(RouterProvider, { router }));
}

describe("AppTopBar", () => {
  it("renders the notifications bell pinned to the top row when no page chrome is set", () => {
    renderTopBar(null);
    screen.getByLabelText("Notifications");
  });

  it("renders page-chrome content in its own row, alongside the notifications bell", () => {
    renderTopBar(
      React.createElement("button", { type: "button" }, "Chat about this"),
    );
    screen.getByRole("button", { name: "Chat about this" });
    screen.getByLabelText("Notifications");
  });

  it("keeps the notifications bell in the top row rather than the page-chrome row", () => {
    const { container } = renderTopBar(
      React.createElement("button", { type: "button" }, "Chat about this"),
    );
    const rows = container.querySelectorAll("header > div");
    expect(rows.length).toBe(2);
    within(rows[0] as HTMLElement).getByLabelText("Notifications");
    expect(
      within(rows[0] as HTMLElement).queryByRole("button", {
        name: "Chat about this",
      }),
    ).toBeNull();
    within(rows[1] as HTMLElement).getByRole("button", {
      name: "Chat about this",
    });
  });

  it("does not render a second row when no page chrome is registered", () => {
    const { container } = renderTopBar(null);
    const rows = container.querySelectorAll("header > div");
    expect(rows.length).toBe(1);
  });
});
