/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("../../lib/hub-api", () => ({
  getMe: () => Promise.resolve({ isAdmin: false }),
}));

mock.module("../AuthProvider", () => ({
  useAuth: () => ({
    session: { status: "authenticated", user: { name: "Alice" } },
    signOut: () => {},
  }),
}));

mock.module("../../hooks/use-myra-threads", () => ({
  useMyraThreads: () => ({ data: [], isLoading: false }),
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
  branding: { env: "staging", label: "Staging", title: "Workbench Staging" },
}));

const { AppSidebar } = require("./AppSidebar");

afterEach(() => {
  cleanup();
});

describe("AppSidebar environment badge", () => {
  it("renders the environment label as a distinct badge beside the product name", () => {
    render(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          React.createElement(AppSidebar),
        ),
      ),
    );
    const product = screen.getByText("Workbench");
    const badge = screen.getByText("Staging");
    expect(badge).not.toBe(product);
    expect(product.contains(badge)).toBe(false);
    expect(badge.textContent).toBe("Staging");
  });
});
