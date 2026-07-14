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
  it("renders the notifications bell when no page chrome is set", () => {
    renderTopBar(null);
    screen.getByLabelText("Notifications");
  });

  it("renders page-chrome content alongside the notifications bell in the same bar", () => {
    renderTopBar(
      React.createElement("button", { type: "button" }, "Chat about this"),
    );
    screen.getByRole("button", { name: "Chat about this" });
    screen.getByLabelText("Notifications");
  });

  it("renders a single header bar, not a second row, whether or not page chrome is set", () => {
    const withChrome = render(
      React.createElement(RouterProvider, {
        router: createMemoryRouter(
          [
            {
              path: "/",
              element: React.createElement(
                ActiveContextProvider,
                null,
                React.createElement(
                  PageChromeProvider,
                  null,
                  React.createElement(PageChromeSetter, {
                    node: React.createElement(
                      "button",
                      { type: "button" },
                      "Chat about this",
                    ),
                  }),
                  React.createElement(AppTopBar, { onOpenMenu: () => {} }),
                ),
              ),
            },
          ],
          { initialEntries: ["/"] },
        ),
      }),
    );
    const header = withChrome.container.querySelector(
      "header",
    ) as HTMLElement;
    expect(withChrome.container.querySelectorAll("header").length).toBe(1);
    // A second, bordered row (the prior two-row layout) always carried a
    // border-t divider between it and the top row — its absence means the
    // chrome and the bell render in the same undivided bar.
    expect(header.querySelector(".border-t")).toBeNull();
    within(header).getByRole("button", { name: "Chat about this" });
    within(header).getByLabelText("Notifications");
    withChrome.unmount();

    const withoutChrome = renderTopBar(null);
    expect(withoutChrome.container.querySelectorAll("header").length).toBe(1);
  });
});
