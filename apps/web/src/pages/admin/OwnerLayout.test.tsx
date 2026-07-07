/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let ownerFlag = false;
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
      isAdmin: ownerFlag,
      isOwner: ownerFlag,
    }),
}));

mock.module("react-router", () => ({
  NavLink: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children as React.ReactNode),
  Outlet: () => React.createElement("div", null, "section-content"),
}));

import { OwnerLayout } from "./OwnerLayout";

function renderLayout() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OwnerLayout />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("OwnerLayout gate", () => {
  it("shows a no-access state for a non-owner", async () => {
    ownerFlag = false;
    renderLayout();
    await waitFor(() => expect(screen.getByText("Owner only")));
    expect(screen.queryByText("section-content")).toBeNull();
  });

  it("renders the owner shell (and its content outlet) for an owner", async () => {
    ownerFlag = true;
    renderLayout();
    await waitFor(() => expect(screen.getByText("section-content")));
    expect(screen.queryByText("Owner only")).toBeNull();
  });
});
