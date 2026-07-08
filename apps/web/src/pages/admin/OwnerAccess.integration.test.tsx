/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";

// The security-relevant invariant the shell exists to enforce: a non-owner must
// never reach owner data. Exercised through the REAL router + real OwnerLayout
// gate + real OwnerCatalog outlet (the landing) — only hub-api is mocked, so the
// gate genuinely stands between the route and the fetch. Catches a regression
// where the gate is moved below <Outlet/> (child mounts before the check).

let ownerFlag = false;
const getTenantProviders = mock(async () => []);
const getTenantModels = mock(async () => []);
mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: "ten_root" }),
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
  getTenantProviders,
  getTenantModels,
}));

const { OwnerLayout } = await import("./OwnerLayout");
const { OwnerCatalog } = await import("./OwnerCatalog");

function renderAtOwner() {
  const router = createMemoryRouter(
    [
      {
        path: "/owner",
        element: <OwnerLayout />,
        children: [{ index: true, element: <OwnerCatalog /> }],
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
  getTenantProviders.mockClear();
  getTenantModels.mockClear();
});

describe("/owner access gate", () => {
  it("a non-owner sees no-access and never fetches owner data", async () => {
    ownerFlag = false;
    renderAtOwner();
    await waitFor(() => expect(screen.getByText("Owner only")));
    expect(getTenantProviders).toHaveBeenCalledTimes(0);
  });

  it("an owner reaches the catalog and fetches owner data", async () => {
    ownerFlag = true;
    renderAtOwner();
    await waitFor(() => expect(getTenantProviders).toHaveBeenCalled());
  });
});
