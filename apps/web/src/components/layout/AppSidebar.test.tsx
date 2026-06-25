/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

mock.module("../AuthProvider", () => ({
  useAuth: () => ({
    session: { status: "authenticated", user: { name: "Alice" } },
    signOut: () => {},
  }),
}));

mock.module("../../hooks/use-myra-threads", () => ({
  useMyraThreads: () => ({
    data: [
      {
        id: "t1",
        instanceId: "i1",
        label: "First chat",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    isLoading: false,
  }),
  useCreateMyraThread: () => ({ mutate: () => {}, isPending: false }),
  useRenameMyraThread: () => ({ mutate: () => {}, isPending: false }),
  useDeleteMyraThread: () => ({ mutate: () => {}, isPending: false }),
  writeLastActiveThreadId: () => {},
  resolveActiveThread: () => null,
}));

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: null,
    activeTenantId: null,
    setActiveWorkbench: () => {},
  }),
}));

mock.module("../../lib/app-env", () => ({
  branding: { env: null, label: null, title: "Workbench" },
}));

const { AppSidebar } = require("./AppSidebar");

afterEach(() => {
  cleanup();
});

function renderSidebar(path = "/") {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(AppSidebar),
    ),
  );
}

describe("AppSidebar", () => {
  it("renders the primary nav and Settings link", () => {
    renderSidebar();
    expect(
      (
        screen.getByRole("link", { name: /workflows/i }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/workflows");
    expect(
      (
        screen.getByRole("link", { name: /skills/i }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/skills");
    expect(
      (
        screen.getByRole("link", { name: /insights/i }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/insights");
    expect(
      (
        screen.getByRole("link", { name: /settings/i }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/settings");
  });

  it("renders the New Chat action and the thread list", () => {
    renderSidebar();
    const newChat = screen.getByRole("button", { name: /new chat/i });
    expect((newChat as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("First chat").textContent).toBe("First chat");
  });

  it("omits the environment badge when no environment is configured", () => {
    renderSidebar();
    expect(screen.getByText("Workbench").textContent).toBe("Workbench");
    expect(screen.queryByText("Staging")).toBeNull();
    expect(screen.queryByText("Spike")).toBeNull();
  });
});
