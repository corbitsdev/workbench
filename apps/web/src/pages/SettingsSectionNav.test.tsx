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

function renderNav(path = "/settings") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
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
  it("shows no management group (and no group headings) for a plain member", async () => {
    meFlags = { isAdmin: false, isOwner: false };
    renderNav();
    await waitFor(() => screen.getByText("Your agent"));
    expect(screen.queryByText("Users & agents")).toBeNull();
    expect(screen.queryByText("Workbench management")).toBeNull();
    expect(screen.queryByText("Management")).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
  });

  it("shows only Users & agents for an admin who is not an owner", async () => {
    meFlags = { isAdmin: true, isOwner: false };
    renderNav();
    await waitFor(() => screen.getByText("Users & agents"));
    expect(screen.queryByText("Workbench management")).toBeNull();
  });

  it("shows both management groups for an owner (owner implies admin)", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav();
    await waitFor(() => screen.getByText("Users & agents"));
    expect(screen.getByText("Workbench management")).toBeTruthy();
  });

  it("labels the two groups with uppercase headings so route links read apart from anchors", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav();
    await waitFor(() => screen.getByText("Users & agents"));
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("Management")).toBeTruthy();
  });

  it("links the admin group at /settings/admin and the owner group at /settings/owner", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav();
    const adminLink = (await screen.findByText(
      "Users & agents",
    )) as HTMLElement;
    const ownerLink = screen.getByText("Workbench management") as HTMLElement;
    expect(adminLink.closest("a")?.getAttribute("href")).toBe(
      "/settings/admin",
    );
    expect(ownerLink.closest("a")?.getAttribute("href")).toBe(
      "/settings/owner",
    );
  });
});

describe("SettingsSectionNav active state on management routes", () => {
  it("marks Users & agents active on a /settings/admin sub-route", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav("/settings/admin/principals");
    const adminLink = (await screen.findByText(
      "Users & agents",
    )) as HTMLElement;
    expect(adminLink.closest("a")?.getAttribute("aria-current")).toBe("page");
    const ownerLink = screen.getByText("Workbench management") as HTMLElement;
    expect(ownerLink.closest("a")?.getAttribute("aria-current")).toBeNull();
  });

  it("marks Workbench management active on a /settings/owner sub-route", async () => {
    meFlags = { isAdmin: true, isOwner: true };
    renderNav("/settings/owner/catalog");
    const ownerLink = (await screen.findByText(
      "Workbench management",
    )) as HTMLElement;
    expect(ownerLink.closest("a")?.getAttribute("aria-current")).toBe("page");
  });

  it("routes personal anchors through /settings when viewed from a management page", async () => {
    meFlags = { isAdmin: true, isOwner: false };
    renderNav("/settings/admin/principals");
    await waitFor(() => screen.getByText("Users & agents"));
    const personal = screen.getByText("Your agent") as HTMLElement;
    expect(personal.closest("a")?.getAttribute("href")).toBe(
      "/settings#your-agent",
    );
  });

  it("keeps personal anchors as same-page hash links on the personal page", async () => {
    meFlags = { isAdmin: false, isOwner: false };
    renderNav("/settings");
    await waitFor(() => screen.getByText("Your agent"));
    const personal = screen.getByText("Your agent") as HTMLElement;
    expect(personal.closest("a")?.getAttribute("href")).toBe("#your-agent");
  });
});
