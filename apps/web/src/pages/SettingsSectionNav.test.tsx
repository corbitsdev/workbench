/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

let meFlags: { isAdmin: boolean; isOwner: boolean } = {
  isAdmin: false,
  isOwner: false,
};

mock.module("../lib/hub-api", () => ({
  getMe: () =>
    Promise.resolve({
      userId: "u1",
      userName: "Test User",
      personalTenantId: "tenant-1",
      rootTenantIds: [],
      paInstanceId: null,
      provisioned: true,
      credentialResolved: true,
      isAdmin: meFlags.isAdmin,
      isOwner: meFlags.isOwner,
    }),
}));

const { SettingsSectionNav } = await import("./SettingsSectionNav");

function renderNav() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsSectionNav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  meFlags = { isAdmin: false, isOwner: false };
});

describe("SettingsSectionNav management group visibility", () => {
  it("shows no management group for a plain member", async () => {
    meFlags = { isAdmin: false, isOwner: false };
    renderNav();
    await waitFor(() => screen.getByText("Your agent"));
    expect(screen.queryByText("Workspace users & agents")).toBeNull();
    expect(screen.queryByText("Workspace management")).toBeNull();
  });

  it("shows only Workspace users & agents for an admin who is not an owner", async () => {
    meFlags = { isAdmin: true, isOwner: false };
    renderNav();
    await waitFor(() => screen.getByText("Workspace users & agents"));
    expect(screen.queryByText("Workspace management")).toBeNull();
  });

  it("shows both management groups for an owner (owner implies admin)", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav();
    await waitFor(() => screen.getByText("Workspace users & agents"));
    expect(screen.getByText("Workspace management")).toBeTruthy();
  });

  it("links the admin group at /settings/admin and the owner group at /settings/owner", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav();
    const adminLink = (await screen.findByText(
      "Workspace users & agents",
    )) as HTMLElement;
    const ownerLink = screen.getByText("Workspace management") as HTMLElement;
    expect(adminLink.closest("a")?.getAttribute("href")).toBe(
      "/settings/admin",
    );
    expect(ownerLink.closest("a")?.getAttribute("href")).toBe(
      "/settings/owner",
    );
  });
});
