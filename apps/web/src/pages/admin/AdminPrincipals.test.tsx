/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const elevateMutate = mock((_vars: unknown, _opts?: unknown) => {});
const demoteMutate = mock((_vars: unknown, _opts?: unknown) => {});

const member = {
  id: "prn_1",
  kind: "user" as const,
  refId: "u1",
  status: "active",
  displayName: "Ada Lovelace",
  roles: [],
  isAdmin: false,
};
const adminP = {
  id: "prn_2",
  kind: "user" as const,
  refId: "u2",
  status: "active",
  displayName: "Grace Hopper",
  roles: [{ id: "rol_admin", name: "admin" }],
  isAdmin: true,
};

mock.module("../../hooks/use-admin", () => ({
  useAdminPrincipals: () => ({
    data: [member, adminP],
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

mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children),
}));

import { AdminPrincipals } from "./AdminPrincipals";

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AdminPrincipals />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  elevateMutate.mockClear();
  demoteMutate.mockClear();
});

describe("AdminPrincipals elevate/demote with confirmation", () => {
  it("does NOT elevate on the first click — only after confirm", async () => {
    renderPage();
    fireEvent.click(screen.getByText("Ada Lovelace"));
    const btn = await screen.findByRole("button", { name: "Make admin" });

    fireEvent.click(btn);
    // First click arms the confirm; the mutation must not fire yet.
    expect(elevateMutate).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("button", {
      name: "Confirm make admin",
    });
    fireEvent.click(confirm);
    expect(elevateMutate).toHaveBeenCalledTimes(1);
    const vars = elevateMutate.mock.calls[0]?.[0] as { principalId: string };
    expect(vars.principalId).toBe("prn_1");
  });

  it("does NOT demote on the first click — only after confirm", async () => {
    renderPage();
    fireEvent.click(screen.getByText("Grace Hopper"));
    const btn = await screen.findByRole("button", { name: "Remove admin" });

    fireEvent.click(btn);
    expect(demoteMutate).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("button", {
      name: "Confirm remove admin",
    });
    fireEvent.click(confirm);
    expect(demoteMutate).toHaveBeenCalledTimes(1);
    const vars = demoteMutate.mock.calls[0]?.[0] as { principalId: string };
    expect(vars.principalId).toBe("prn_2");
  });

  it("shows a make-admin control for a non-admin and remove-admin for an admin", async () => {
    renderPage();
    fireEvent.click(screen.getByText("Ada Lovelace"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Make admin" })),
    );
    expect(screen.queryByRole("button", { name: "Remove admin" })).toBeNull();
  });
});
