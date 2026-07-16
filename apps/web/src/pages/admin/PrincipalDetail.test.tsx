/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const elevateMutate = mock((_vars: unknown, _opts?: unknown) => {});
const demoteMutate = mock((_vars: unknown, _opts?: unknown) => {});

let principal = {
  id: "prn_1",
  kind: "user" as const,
  refId: "u1",
  status: "active",
  displayName: "Ada Lovelace",
  roles: [],
  isAdmin: false,
};

mock.module("../../hooks/use-admin", () => ({
  usePrincipalDetail: () => ({
    data: principal,
    isLoading: false,
    isError: false,
  }),
  usePrincipalGrants: () => ({
    data: { principalId: "prn_1", isAdmin: false, roles: [], grants: [] },
    isLoading: false,
    isError: false,
  }),
  useElevateToAdmin: () => ({ mutate: elevateMutate, isPending: false }),
  useDemoteFromAdmin: () => ({ mutate: demoteMutate, isPending: false }),
}));

let searchString = "";
mock.module("react-router", () => ({
  useParams: () => ({ id: "prn_1" }),
  useSearchParams: () => [new URLSearchParams(searchString), mock(() => {})],
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children),
}));

import { PrincipalDetail } from "./PrincipalDetail";

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PrincipalDetail />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  elevateMutate.mockClear();
  demoteMutate.mockClear();
  searchString = "";
  principal = {
    id: "prn_1",
    kind: "user",
    refId: "u1",
    status: "active",
    displayName: "Ada Lovelace",
    roles: [],
    isAdmin: false,
  };
});

describe("PrincipalDetail", () => {
  it("renders a breadcrumb that links back to the Principals tab", () => {
    renderPage();
    const crumb = screen.getByText("Principals");
    expect(crumb.closest("a")?.getAttribute("href")).toBe(
      "/settings/admin/principals",
    );
  });

  it("breadcrumb back link restores the origin page + filters from ?back=", () => {
    searchString = `back=${encodeURIComponent("page=4&type=agent")}`;
    renderPage();
    const href = screen
      .getByText("Principals")
      .closest("a")
      ?.getAttribute("href");
    const [path, query] = (href ?? "").split("?");
    expect(path).toBe("/settings/admin/principals");
    const restored = new URLSearchParams(query);
    expect(restored.get("page")).toBe("4");
    expect(restored.get("type")).toBe("agent");
  });

  it("elevates only after confirmation", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Make admin" }));
    expect(elevateMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm make admin" }));
    expect(elevateMutate).toHaveBeenCalledTimes(1);
    const vars = elevateMutate.mock.calls[0]?.[0] as { principalId: string };
    expect(vars.principalId).toBe("prn_1");
  });

  it("shows Remove admin (not Make admin) for an admin principal", () => {
    principal = { ...principal, isAdmin: true };
    renderPage();
    expect(
      screen.getByRole("button", { name: "Remove admin" }).textContent,
    ).toBe("Remove admin");
    expect(screen.queryByRole("button", { name: "Make admin" })).toBeNull();
  });
});
