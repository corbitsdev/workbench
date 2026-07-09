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
import { MemoryRouter, Route, Routes } from "react-router";

let artifactResult: {
  data?: {
    id: string;
    kind: string;
    title: string;
    ownerPrincipalId?: string | null;
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
  }),
}));
mock.module("../components/ArtifactBody", () => ({
  default: (props: { artifact: { title: string } }) =>
    React.createElement("div", { "data-testid": "body" }, props.artifact.title),
}));

import { ArtifactDetailPage } from "./ArtifactDetailPage";

function renderAt(id: string): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/artifacts/${id}`] },
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
  );
}

beforeEach(() => {
  artifactResult = {
    data: {
      id: "art-1",
      kind: "one-pager",
      title: "Acme One-Pager",
      ownerPrincipalId: null,
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
  it("renders the artifact full-page", () => {
    const view = renderAt("art-1");
    expect(view.getByRole("heading", { name: "Acme One-Pager" })).toBeDefined();
    expect(view.getByTestId("body").textContent).toBe("Acme One-Pager");
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

  it("opens the dock seeded with the artifact when 'Chat about this artifact' is clicked", () => {
    const view = renderAt("art-1");
    fireEvent.click(
      view.getByRole("button", { name: /chat about this artifact/i }),
    );
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
    fireEvent.click(archiveButton);
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
});
