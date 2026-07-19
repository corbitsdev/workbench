/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PageChromeProvider, usePageChromeSlot } from "../lib/page-chrome";

// Stands in for AppTopBar's chrome consumer so tests can interact with the
// search/view-toggle/add-skill controls SkillsLibrary pushes into the shared
// top bar via useSetPageChrome, without mounting the whole app shell.
function ChromeSlotProbe() {
  return React.createElement("div", null, usePageChromeSlot());
}

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

const meResponse = {
  userId: "u1",
  userName: "Test User",
  personalTenantId: "tenant-1",
  rootTenantIds: [],
  paInstanceId: null,
  provisioned: true,
  credentialResolved: true,
};

// A controllable getMe: most tests want it to resolve immediately, but the
// tenant-gating flash test needs to hold it pending to observe the window
// before `personalTenantId` (and so `tenantId`) resolves.
let meDeferred: { promise: Promise<typeof meResponse> } = {
  promise: Promise.resolve(meResponse),
};

mock.module("../lib/hub-api", () => ({
  getMe: () => meDeferred.promise,
}));

mock.module("react-router", () => ({
  useNavigate: () => mock(() => {}),
}));

import { SkillsLibrary } from "./SkillsLibrary";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const skills = [
  {
    id: "skill-1",
    name: "asap",
    displayName: "ASAP",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    scope: "tenant",
    accessTenantId: "tenant-root",
    ownerUserId: "usr-1",
    ownerName: "Ada Lovelace",
  },
  {
    id: "skill-2",
    name: "private-one",
    displayName: "Private One",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    scope: "private",
    accessTenantId: "tenant-1",
    ownerUserId: "usr-2",
    ownerName: "Grace Hopper",
  },
  {
    id: "skill-3",
    name: "viral-content",
    displayName: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    scope: "tenant",
    accessTenantId: "tenant-root",
    ownerUserId: "usr-3",
    ownerName: "Alan Turing",
  },
  {
    id: "skill-4",
    name: "landing-page",
    displayName: "landing-page",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    scope: "tenant",
    accessTenantId: "tenant-root",
    ownerUserId: "usr-4",
    ownerName: "Katherine Johnson",
  },
];

beforeEach(() => {
  localStorage.clear();
  window.happyDOM.setURL("http://localhost/");
  meDeferred = { promise: Promise.resolve(meResponse) };
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/skills/share-targets")) {
      return Promise.resolve(
        jsonResponse({
          targets: [{ tenantId: "tenant-root", name: "Corbits" }],
        }),
      );
    }
    if (String(url).includes("/skills")) {
      return Promise.resolve(jsonResponse({ skills }));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        PageChromeProvider,
        null,
        React.createElement(ChromeSlotProbe, null),
        React.createElement(SkillsLibrary),
      ),
    ),
  );
}

describe("SkillsLibrary", () => {
  it("shows owner and a resolved access label per skill", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.body.textContent).toContain("Corbits");
  });

  it("humanizes a kebab-case skill name when no displayName is set", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Viral content"),
    );
    expect(document.body.textContent).not.toContain("viral-content");
  });

  it("humanizes a slug-shaped displayName stored verbatim at creation (card view)", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Landing page"),
    );
    expect(document.body.textContent).not.toContain("landing-page");
  });

  it("leaves a real human-authored displayName unchanged", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Private One"),
    );
  });

  it("labels private skills as Private", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Private One"),
    );
    expect(document.body.textContent).toContain("Grace Hopper");
    expect(document.body.textContent).toContain("Private");
  });

  it("switches to a rows table and persists the preference when toggled", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(screen.getByLabelText("Rows view"));

    await screen.findByRole("table");
    screen.getByRole("columnheader", { name: "Access" });
    screen.getByRole("columnheader", { name: "Owner" });
    expect(localStorage.getItem("cw-view-skills")).toBe("rows");
  });

  it("starts in rows view when the stored preference is rows", async () => {
    localStorage.setItem("cw-view-skills", "rows");
    renderPage();

    await screen.findByRole("table");
  });

  it("humanizes a kebab-case skill name in rows view when no displayName is set", async () => {
    localStorage.setItem("cw-view-skills", "rows");
    renderPage();

    await screen.findByRole("table");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Viral content"),
    );
    expect(document.body.textContent).not.toContain("viral-content");
  });

  it("humanizes a slug-shaped displayName in rows view", async () => {
    localStorage.setItem("cw-view-skills", "rows");
    renderPage();

    await screen.findByRole("table");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Landing page"),
    );
    expect(document.body.textContent).not.toContain("landing-page");
  });

  it("does not flash the empty state while tenantId is still resolving", async () => {
    let resolveMe: (value: typeof meResponse) => void = () => {};
    meDeferred = {
      promise: new Promise((resolve) => {
        resolveMe = resolve;
      }),
    };

    renderPage();

    // useSkillLibrary is disabled until tenantId resolves, so this window has
    // no data and no fetch in flight — the empty-state text must not render.
    expect(document.body.textContent).not.toContain("No skills yet");
    expect(document.body.textContent).toContain("Loading skills");

    resolveMe(meResponse);
    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));
    expect(document.body.textContent).not.toContain("No skills yet");
  });
});
