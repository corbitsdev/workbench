/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let sidebarIsAdmin = false;
let sidebarDemoLinks: { label: string; href: string; icon: string }[] = [];
mock.module("../../lib/hub-api", () => ({
  getMe: () =>
    Promise.resolve({ isAdmin: sidebarIsAdmin, demoLinks: sidebarDemoLinks }),
}));

const DEMO_FIXTURE = [
  {
    label: "Deal Scout",
    href: "https://deal-scout-abklabs.vercel.app/",
    icon: "search",
  },
  {
    label: "Notion Spike",
    href: "https://app-notion-spike.up.railway.app/",
    icon: "file-text",
  },
  {
    label: "Workbench (staging)",
    href: "https://workbench-ui-git-staging-abklabs.vercel.app/",
    icon: "flask",
  },
];

mock.module("../AuthProvider", () => ({
  useAuth: () => ({
    session: { status: "authenticated", user: { name: "Alice" } },
    signOut: () => {},
  }),
}));

mock.module("../../hooks/use-myra-threads", () => ({
  useMyraThreads: () => ({
    data: {
      threads: [
        {
          id: "t1",
          instanceId: "i1",
          label: "First chat",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    },
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
  sidebarDemoLinks = [];
  sidebarIsAdmin = false;
});

function renderSidebar(path = "/", props: Record<string, unknown> = {}) {
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(AppSidebar, props),
      ),
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

  it("lists Inbox first in the primary nav", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: /main navigation/i });
    const labels = Array.from(nav.querySelectorAll("a")).map(
      (a) => a.textContent,
    );
    expect(labels[0]).toBe("Inbox");
  });

  it("renders the New Chat action and the thread list", () => {
    renderSidebar();
    const newChat = screen.getByRole("button", { name: /new chat/i });
    expect((newChat as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("First chat").textContent).toBe("First chat");
  });

  it("hides the mobile drawer off-canvas when closed", () => {
    renderSidebar("/", { mobileOpen: false });
    const aside = screen.getByRole("complementary");
    expect(aside.className).toContain("max-md:-translate-x-full");
    expect(aside.className).not.toContain("max-md:translate-x-0");
  });

  it("slides the mobile drawer into view when open", () => {
    renderSidebar("/", { mobileOpen: true });
    const aside = screen.getByRole("complementary");
    expect(aside.className).toContain("max-md:translate-x-0");
    expect(aside.className).not.toContain("max-md:-translate-x-full");
  });

  it("calls onNavigate when a nav item is selected so the drawer can close", () => {
    let closed = 0;
    renderSidebar("/", { onNavigate: () => (closed += 1) });
    (screen.getByRole("link", { name: /workflows/i }) as HTMLElement).click();
    expect(closed).toBe(1);
  });

  it("renders the Demos section from the /me payload, linking out to each demo", async () => {
    sidebarDemoLinks = DEMO_FIXTURE;
    renderSidebar();
    const cases = [
      { name: /deal scout/i, href: "https://deal-scout-abklabs.vercel.app/" },
      {
        name: /notion spike/i,
        href: "https://app-notion-spike.up.railway.app/",
      },
      {
        name: /workbench \(staging\)/i,
        href: "https://workbench-ui-git-staging-abklabs.vercel.app/",
      },
    ];
    for (const { name, href } of cases) {
      const link = (await screen.findByRole("link", {
        name,
      })) as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("hides the Demos section entirely when the payload carries no demo links", async () => {
    sidebarDemoLinks = DEMO_FIXTURE;
    renderSidebar();
    // Wait for the async /me payload to land (a demo link appears), then
    // re-render with an empty payload and confirm the section is gone.
    await screen.findByRole("link", { name: /deal scout/i });
    cleanup();
    sidebarDemoLinks = [];
    renderSidebar();
    // Let the mocked /me promise settle so absence is post-payload, not
    // just pre-fetch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("Demos")).toBeNull();
    expect(screen.queryByRole("link", { name: /deal scout/i })).toBeNull();
  });

  it("calls onNavigate when a demo link is selected so the drawer can close", async () => {
    sidebarDemoLinks = DEMO_FIXTURE;
    let closed = 0;
    renderSidebar("/", { onNavigate: () => (closed += 1) });
    (
      (await screen.findByRole("link", {
        name: /deal scout/i,
      })) as HTMLElement
    ).click();
    expect(closed).toBe(1);
  });

  it("omits the environment badge when no environment is configured", () => {
    renderSidebar();
    expect(screen.getByText("Workbench").textContent).toBe("Workbench");
    expect(screen.queryByText("Staging")).toBeNull();
    expect(screen.queryByText("Spike")).toBeNull();
  });

  it("does not show a top-level Tools nav item (moved under Admin)", () => {
    sidebarIsAdmin = false;
    renderSidebar();
    expect(screen.queryByRole("link", { name: /^tools$/i })).toBeNull();
  });

  it("shows no Admin or Owner entry anywhere in the sidebar, even for admins (management lives under Settings)", async () => {
    sidebarIsAdmin = true;
    sidebarDemoLinks = DEMO_FIXTURE;
    renderSidebar();
    // Wait for the async /me payload to land (a demo link appears) so the
    // absence assertions run post-payload, when an Admin entry would render
    // if one still existed.
    await screen.findByRole("link", { name: /deal scout/i });
    expect(screen.queryByRole("link", { name: /^admin$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^owner$/i })).toBeNull();
    expect(document.querySelector('a[href="/settings/admin"]')).toBeNull();
    expect(document.querySelector('a[href="/settings/owner"]')).toBeNull();
    expect(
      (
        screen.getByRole("link", { name: /settings/i }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/settings");
  });

  it("does not show Sign out in the sidebar footer", () => {
    sidebarIsAdmin = false;
    renderSidebar();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();

    cleanup();
    sidebarIsAdmin = true;
    renderSidebar();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });
});
