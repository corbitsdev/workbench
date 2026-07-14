/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import {
  PageChromeProvider,
  usePageChromeSlot,
} from "../lib/page-chrome";

let artifactResult: {
  data?: {
    id: string;
    kind: string;
    title: string;
    version?: number;
    status?: string;
    ownerPrincipalId?: string | null;
    createdAt?: string;
    sessionId?: string | null;
    sessionName?: string | null;
    sessionStatus?: string | null;
    parentId?: string | null;
  };
  isLoading: boolean;
  isError: boolean;
};

let meResult: { isAdmin?: boolean; isOwner?: boolean } = { isAdmin: true };
const archiveMutate = mock(
  (_vars: unknown, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
  },
);

const openWithMessage = mock((_message: string) => {});

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    activeTenantId: "tenant-1",
    activeWorkbench: { id: "prn-me" },
  }),
}));
mock.module("../lib/chat-launcher-context", () => ({
  useChatLauncher: () => ({ openWithMessage }),
}));
mock.module("../lib/hub-api", () => ({
  getMe: () => Promise.resolve(meResult),
}));
mock.module("@workbench/client/react", () => ({
  useArtifact: () => artifactResult,
  useTenantMembers: () => ({ data: [] }),
  useArchiveArtifact: () => ({
    mutate: archiveMutate,
    isPending: false,
    isError: false,
  }),
}));
mock.module("../components/ArtifactBody", () => ({
  default: (props: { artifact: { title: string } }) =>
    React.createElement("div", { "data-testid": "body" }, props.artifact.title),
}));

import { ArtifactDetailPage } from "./ArtifactDetailPage";

function LocationProbe() {
  const location = useLocation();
  return React.createElement(
    "div",
    { "data-testid": "location-path" },
    location.pathname,
  );
}

// Mirrors AppTopBar: renders whatever the page publishes via useSetPageChrome so
// the relocated top-bar actions (Chat about this, Archive) are exercised in tests.
function ChromeSlot() {
  const chrome = usePageChromeSlot();
  return React.createElement("div", { "data-testid": "page-chrome" }, chrome);
}

function renderAt(id: string): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      PageChromeProvider,
      null,
      React.createElement(ChromeSlot),
      React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/artifacts/${id}`] },
        React.createElement(LocationProbe),
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: "/artifacts/:artifactId",
            element: React.createElement(ArtifactDetailPage),
          }),
          React.createElement(Route, {
            path: "/artifacts",
            element: React.createElement(
              "div",
              { "data-testid": "gallery-redirect" },
              "gallery",
            ),
          }),
        ),
      ),
      ),
    ),
  );
}

beforeEach(() => {
  artifactResult = {
    data: {
      id: "art-1",
      kind: "one-pager",
      title: "Acme One-Pager",
      version: 3,
      status: "approved",
      ownerPrincipalId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      sessionId: null,
      sessionName: null,
      sessionStatus: null,
      parentId: null,
    },
    isLoading: false,
    isError: false,
  };
  meResult = { isAdmin: true };
  archiveMutate.mockClear();
  openWithMessage.mockClear();
});
afterEach(() => cleanup());

describe("ArtifactDetailPage", () => {
  it("renders the artifact full-page without a redundant title header", () => {
    const view = renderAt("art-1");
    expect(view.getByTestId("body").textContent).toBe("Acme One-Pager");
    expect(view.getByTestId("artifact-detail-shell")).toBeDefined();
    // The app top bar already names the artifact; the detail shell must not
    // repeat it as a secondary <h1>/back-button header band.
    expect(view.queryByRole("heading", { name: "Acme One-Pager" })).toBeNull();
    expect(view.queryByRole("button", { name: /back to artifacts/i })).toBeNull();
  });

  it("shows the version and status in the metadata rail", () => {
    const view = renderAt("art-1");
    const rail = view.getByTestId("artifact-detail-rail");
    expect(rail.textContent).toContain("v3");
    expect(rail.textContent).toContain("Approved");
  });

  it("surfaces the Chat about this and Archive actions in the top-bar chrome", () => {
    const view = renderAt("art-1");
    const chrome = view.getByTestId("page-chrome");
    expect(chrome.textContent).toContain("Chat about this");
    expect(chrome.textContent).toContain("Archive");
  });

  it("shows a not-found state when the artifact fetch fails", () => {
    artifactResult = { isLoading: false, isError: true };
    const view = renderAt("does-not-exist");
    view.getByText(/couldn't be found/i);
  });

  it("does not render the in-pane chat composer (Myra lives in the dock)", () => {
    const view = renderAt("art-1");
    expect(
      view.queryByPlaceholderText(/ask myra about this artifact/i),
    ).toBeNull();
    expect(view.queryByRole("button", { name: /start chat/i })).toBeNull();
  });

  it("opens the dock seeded with the artifact when 'Chat about this' is clicked", () => {
    const view = renderAt("art-1");
    fireEvent.click(view.getByRole("button", { name: /chat about this/i }));
    expect(openWithMessage).toHaveBeenCalledTimes(1);
    const message = openWithMessage.mock.calls[0][0];
    expect(message).toContain("art-1");
    expect(message).toContain("Acme One-Pager");
    expect(message).toContain("tenant-1");
    expect(message).toContain("artifact_read");
  });

  it("archives and redirects to the gallery for an admin", async () => {
    const view = renderAt("art-1");
    const archiveButton = await view.findByRole("button", {
      name: /archive/i,
    });
    // Archive is guarded by a confirm: the first click arms, the second fires.
    fireEvent.click(archiveButton);
    expect(archiveMutate).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: /confirm archive/i }));
    expect(archiveMutate).toHaveBeenCalledTimes(1);
    expect(archiveMutate.mock.calls[0][0]).toMatchObject({
      artifactId: "art-1",
      tenantId: "tenant-1",
    });
    await waitFor(() =>
      expect(view.getByTestId("gallery-redirect")).toBeDefined(),
    );
  });

  it("hides the archive action from a non-owner, non-admin", () => {
    meResult = { isAdmin: false, isOwner: false };
    artifactResult = {
      data: {
        id: "art-1",
        kind: "one-pager",
        title: "Acme One-Pager",
        ownerPrincipalId: "someone-else",
      },
      isLoading: false,
      isError: false,
    };
    const view = renderAt("art-1");
    expect(view.queryByRole("button", { name: /archive/i })).toBeNull();
  });

  describe("CL-3512: session provenance and lineage", () => {
    it("does not render a session or lineage link when neither is present", () => {
      const view = renderAt("art-1");
      expect(view.queryByRole("button", { name: /derived from/i })).toBeNull();
    });

    it("shows the session status and navigates to the session on click", () => {
      artifactResult = {
        data: {
          id: "art-1",
          kind: "one-pager",
          title: "Acme One-Pager",
          ownerPrincipalId: null,
          sessionId: "sess-42",
          sessionName: "Acme Corp call",
          sessionStatus: "done",
          parentId: null,
        },
        isLoading: false,
        isError: false,
      };
      const view = renderAt("art-1");
      view.getByText("done");
      fireEvent.click(view.getByRole("button", { name: "Acme Corp call" }));
      expect(view.getByTestId("location-path").textContent).toBe(
        "/insights/trace/sess-42",
      );
    });

    it("navigates to the parent artifact when 'Derived from' is clicked", () => {
      artifactResult = {
        data: {
          id: "art-2",
          kind: "one-pager",
          title: "Acme One-Pager v2",
          ownerPrincipalId: null,
          sessionId: null,
          sessionName: null,
          sessionStatus: null,
          parentId: "art-1",
        },
        isLoading: false,
        isError: false,
      };
      const view = renderAt("art-2");
      fireEvent.click(
        view.getByRole("button", { name: /derived from a previous version/i }),
      );
      expect(view.getByTestId("location-path").textContent).toBe(
        "/artifacts/art-1",
      );
    });
  });
});
