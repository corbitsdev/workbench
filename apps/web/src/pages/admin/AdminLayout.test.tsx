/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let adminFlag = false;
mock.module("../../lib/hub-api", () => ({
  getMe: () =>
    Promise.resolve({
      userId: "u1",
      userName: "Test User",
      personalTenantId: "tenant-1",
      rootTenantIds: [],
      paInstanceId: null,
      provisioned: true,
      credentialResolved: true,
      isAdmin: adminFlag,
    }),
}));

mock.module("react-router", () => ({
  NavLink: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children as React.ReactNode),
  Outlet: () => React.createElement("div", null, "section-content"),
}));

import { AdminLayout } from "./AdminLayout";

function renderLayout() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AdminLayout />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("AdminLayout gate", () => {
  it("shows a no-access state for a non-admin", async () => {
    adminFlag = false;
    renderLayout();
    await waitFor(() => expect(screen.getByText("Admin only")));
    expect(screen.queryByText("Principals & Grants")).toBeNull();
  });

  it("renders the admin sub-nav for an admin", async () => {
    adminFlag = true;
    renderLayout();
    await waitFor(() => expect(screen.getByText("Principals & Grants")));
    expect(screen.getByText("Audit"));
  });
});
