/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";

// The security-relevant invariant the shell exists to enforce: a non-owner must
// never reach owner data. Exercised through the REAL router + real OwnerLayout
// gate + real OwnerOverview outlet — only the hub-api module is mocked, so the
// gate genuinely stands between the route and the fetch. Catches a regression
// where the gate is moved below <Outlet/> (child mounts before the check).

let ownerFlag = false;
const getOwnerContext = mock(async () => ({
  tenantId: "ten_root",
  ownerPrincipalId: "prn_owner",
}));
mock.module("../../lib/hub-api", () => ({
  getMe: () =>
    Promise.resolve({
      userId: "u1",
      userName: "U",
      personalTenantId: "ten_root",
      rootTenantIds: [],
      paInstanceId: null,
      provisioned: true,
      credentialResolved: true,
      isAdmin: ownerFlag,
      isOwner: ownerFlag,
    }),
  getOwnerContext,
}));

const { OwnerLayout } = await import("./OwnerLayout");
const { OwnerOverview } = await import("./OwnerOverview");

function renderAtOwner() {
  const router = createMemoryRouter(
    [
      {
        path: "/owner",
        element: <OwnerLayout />,
        children: [{ index: true, element: <OwnerOverview /> }],
      },
    ],
    { initialEntries: ["/owner"] },
  );
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getOwnerContext.mockClear();
});

describe("/owner access gate", () => {
  it("a non-owner sees no-access and never fetches owner context", async () => {
    ownerFlag = false;
    renderAtOwner();
    await waitFor(() => expect(screen.getByText("Owner only")));
    expect(getOwnerContext).toHaveBeenCalledTimes(0);
  });

  it("an owner reaches the overview and fetches owner context", async () => {
    ownerFlag = true;
    renderAtOwner();
    await waitFor(() => expect(screen.getByText("ten_root")));
    expect(getOwnerContext).toHaveBeenCalled();
  });
});
