/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import {
  PageChromeProvider,
  usePageChromeLeadingSlot,
  usePageChromeSlot,
} from "../lib/page-chrome";

let artifactResult: {
  data?: {
    id: string;
    kind: string;
    title: string;
    content?: string;
    source?: Record<string, unknown>;
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

function LeadingSlot() {
  const leading = usePageChromeLeadingSlot();
  return React.createElement(
    "div",
    { "data-testid": "page-chrome-leading" },
    leading,
  );
}

function renderAt(id: string): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      PageChromeProvider,
      null,
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: [`/artifacts/${id}`] },
          React.createElement(LocationProbe),
          React.createElement(ChromeSlot),
          React.createElement(LeadingSlot),
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
    // Wayfinding lives in the top bar (Back to Artifacts); the detail shell must
    // not repeat the title as a secondary <h1> header band.
    expect(view.queryByRole("heading", { name: "Acme One-Pager" })).toBeNull();
    const leading = view.getByTestId("page-chrome-leading");
    expect(
      within(leading).getByRole("link", { name: "Back to Artifacts" }),
    ).toBeDefined();
    expect(
      within(leading)
        .getByRole("link", { name: "Back to Artifacts" })
        .getAttribute("href"),
    ).toBe("/artifacts");
  });

  it("shows the kind, status, version, and date in the page header", () => {
    const view = renderAt("art-1");
    const header = view.getByTestId("artifact-detail-header");
    expect(header.textContent).toContain("v3");
    expect(header.textContent).toContain("Approved");
    expect(header.textContent).toContain("One pager");
    expect(header.textContent).toContain("January 1, 2026");
  });

  it("does not show a Draft badge when the artifact status is draft", () => {
    artifactResult = {
      data: {
        id: "art-draft",
        kind: "one-pager",
        title: "Acme One-Pager",
        version: 1,
        status: "draft",
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
    const view = renderAt("art-draft");
    const header = view.getByTestId("artifact-detail-header");
    expect(header.textContent).not.toContain("Draft");
    expect(within(header).queryByText("Draft", { exact: true })).toBeNull();
  });

  it("collapses the metadata rail entirely when the artifact has no session or lineage provenance", () => {
    const view = renderAt("art-1");
    expect(view.queryByTestId("artifact-detail-rail")).toBeNull();
  });

  it("surfaces the Chat about this and Archive actions in the top-bar chrome", async () => {
    const view = renderAt("art-1");
    const chrome = view.getByTestId("page-chrome");
    expect(view.getByTestId("artifact-detail-chrome-actions")).toBeDefined();
    expect(chrome.textContent).toContain("Chat about this");
    // Archive is gated on the async getMe permission query, so wait for it.
    await view.findByRole("button", { name: /archive/i });
    expect(chrome.textContent).toContain("Archive");
  });

  it("surfaces a Download action above the fold for a downloadable file artifact", async () => {
    artifactResult = {
      data: {
        id: "art-file",
        kind: "file",
        title: "Contract.pdf",
        content: "",
        source: { upload: { filename: "Contract.pdf" } },
      },
      isLoading: false,
      isError: false,
    };
    const view = renderAt("art-file");
    const chrome = view.getByTestId("page-chrome");
    const link = await within(chrome).findByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toMatch(
      /\/artifacts\/art-file\/download$/,
    );
  });

  it("still surfaces Download for a gamma_presentation with a malformed upload field", async () => {
    // gamma_presentation is not in DOWNLOADABLE_ARTIFACT_KINDS — its download
    // action depends entirely on hasUploadSource(source). A legacy row whose
    // upload.mimeType isn't a string must not lose the download action: the
    // strict field-typed schema used by isCsvUpload/extractUploadFilename
    // would reject the whole source, but presence of an upload is what gates
    // this specific check.
    artifactResult = {
      data: {
        id: "art-gamma-legacy",
        kind: "gamma_presentation",
        title: "Legacy Deck",
        content: JSON.stringify({ url: "https://gamma.app/docs/legacy" }),
        source: { upload: { filename: "Legacy.pdf", mimeType: 123 } },
      },
      isLoading: false,
      isError: false,
    };
    const view = renderAt("art-gamma-legacy");
    const chrome = view.getByTestId("page-chrome");
    const link = await within(chrome).findByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toMatch(
      /\/artifacts\/art-gamma-legacy\/download$/,
    );
  });

  it("does not surface a Download action for a non-downloadable kind", () => {
    const view = renderAt("art-1");
    const chrome = view.getByTestId("page-chrome");
    expect(
      within(chrome).queryByRole("link", { name: /download/i }),
    ).toBeNull();
  });

  it("surfaces an Open in Gamma action for a gamma_presentation artifact with a valid deck", async () => {
    artifactResult = {
      data: {
        id: "art-gamma",
        kind: "gamma_presentation",
        title: "Q3 Deck",
        content: JSON.stringify({
          url: "https://gamma.app/docs/q3-deck",
          description: "Q3 deck",
          gammaId: "gid-1",
        }),
      },
      isLoading: false,
      isError: false,
    };
    const view = renderAt("art-gamma");
    const chrome = view.getByTestId("page-chrome");
    const link = await within(chrome).findByRole("link", {
      name: /open in gamma/i,
    });
    expect(link.getAttribute("href")).toBe("https://gamma.app/docs/q3-deck");
  });

  it("does not surface Open in Gamma for a malformed gamma_presentation payload", () => {
    artifactResult = {
      data: {
        id: "art-gamma-bad",
        kind: "gamma_presentation",
        title: "Broken Deck",
        content: "not json",
      },
      isLoading: false,
      isError: false,
    };
    const view = renderAt("art-gamma-bad");
    const chrome = view.getByTestId("page-chrome");
    expect(
      within(chrome).queryByRole("link", { name: /open in gamma/i }),
    ).toBeNull();
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
