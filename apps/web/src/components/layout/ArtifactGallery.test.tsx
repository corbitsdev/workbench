/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import React from "react";
import { PREFERENCE_KEYS } from "@workbench/ui";
import type { ArtifactWithSession } from "@workbench/shared";
import { ChatLauncherContext } from "../../lib/chat-launcher-context";

const mockOpenWithMessage = mock<(message: string) => void>(() => {});
const mockContextValue: React.ComponentProps<
  typeof ChatLauncherContext.Provider
>["value"] = {
  hidden: false,
  setHidden: () => {},
  notifyProvisioned: () => {},
  registerReconnect: () => {},
  pendingMessage: null,
  openWithMessage: mockOpenWithMessage,
  clearPendingMessage: () => {},
};

import { ArtifactGallery, buildArtifactMessage } from "./ArtifactGallery";

const fakeArtifact: ArtifactWithSession = {
  id: "a-1",
  parentId: null,
  kind: "email",
  title: "Sales automation ROI",
  content: "body",
  status: "approved",
  version: 1,
  ownerPrincipalId: null,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: { origin: "workflow" },
  sessionId: null,
  sessionName: "Acme Corp",
  sessionStatus: "done",
  ownerName: null,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderWithSeededArtifacts(
  tenantId: string,
  artifacts: ArtifactWithSession[],
  ui: React.ReactElement,
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
  client.setQueryData(
    [
      "artifacts",
      tenantId,
      "",
      "newest",
      "",
      "",
      "",
      "",
      "",
      "",
      false,
      "infinite",
    ],
    {
      pages: [{ artifacts, nextCursor: null }],
      pageParams: [null],
    },
  );
  client.setQueryData(["members", tenantId], []);
  // Seed the caller identity so the archive-gate query does not hit the network.
  client.setQueryData(["me"], { isAdmin: false, isOwner: false });
  return render(
    React.createElement(
      ChatLauncherContext.Provider,
      { value: mockContextValue },
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(QueryClientProvider, { client }, ui),
      ),
    ),
  );
}

describe("buildArtifactMessage", () => {
  it("references the artifact by id and title without inlining its content", () => {
    const artifact: ArtifactWithSession = {
      ...fakeArtifact,
      id: "a-42",
      title: "Sales automation ROI",
      content: "DISTINCTIVE_BODY_TEXT_should_not_be_sent",
    };
    const message = buildArtifactMessage(artifact);
    expect(message).toContain("a-42");
    expect(message).toContain("Sales automation ROI");
    expect(message).toContain("artifact_read");
    expect(message).not.toContain("DISTINCTIVE_BODY_TEXT_should_not_be_sent");
  });

  it("includes the tenant clause when a tenant id is provided", () => {
    const message = buildArtifactMessage(fakeArtifact, "tenant-workbench");
    expect(message).toContain("in tenant tenant-workbench");
  });

  // Pins the message format the personal-agent prompt depends on: the `id:`
  // token plus the `artifact_read` tool name. A silent reword here would
  // decouple the message from the prompt nudge; this catches it.
  it("emits the id token and artifact_read tool name the prompt relies on", () => {
    const message = buildArtifactMessage(fakeArtifact);
    expect(message).toContain(`(id: ${fakeArtifact.id})`);
    expect(message).toContain("artifact_read");
  });

  it("escapes double quotes in the title so the framing cannot break", () => {
    const message = buildArtifactMessage({
      ...fakeArtifact,
      title: 'Q3 "final" deck',
    });
    expect(message).toContain('"Q3 \\"final\\" deck"');
    expect(message).toContain(`(id: ${fakeArtifact.id})`);
  });

  it("refuses to reference an artifact with an empty id rather than emit a dead-end message", () => {
    expect(() => buildArtifactMessage({ ...fakeArtifact, id: "" })).toThrow();
  });
});

describe("ArtifactGallery", () => {
  it("renders artifacts returned by the artifacts query", async () => {
    const view = renderWithSeededArtifacts(
      "tenant-workbench",
      [fakeArtifact],
      React.createElement(ArtifactGallery, { tenantId: "tenant-workbench" }),
    );

    await waitFor(() => {
      view.getByText("Sales automation ROI");
    });
    view.getByText("Acme Corp");
  });

  it("uses the default card treatment until the experiment is opted in", async () => {
    const view = renderWithSeededArtifacts(
      "tenant-workbench",
      [fakeArtifact],
      React.createElement(ArtifactGallery, { tenantId: "tenant-workbench" }),
    );

    const card = await view.findByRole("button", {
      name: "Open Sales automation ROI",
    });
    expect(card.className).toContain("hover:rotate-[-1deg]");
    expect(card.className).not.toContain("shadow-sm");
  });

  it("uses the experimental card treatment when the member preference is on", async () => {
    window.localStorage.setItem(
      PREFERENCE_KEYS.experimentalArtifactCards,
      "true",
    );
    const view = renderWithSeededArtifacts(
      "tenant-workbench",
      [fakeArtifact],
      React.createElement(ArtifactGallery, { tenantId: "tenant-workbench" }),
    );

    const card = await view.findByRole("button", {
      name: "Open Sales automation ROI",
    });
    expect(card.className).not.toContain("hover:rotate-[-1deg]");
    expect(card.className).toContain("shadow-sm");
  });

  it("renders an empty state when the query returns no artifacts", async () => {
    const view = renderWithSeededArtifacts(
      "tenant-workbench",
      [],
      React.createElement(ArtifactGallery, { tenantId: "tenant-workbench" }),
    );

    await waitFor(() => {
      expect(view.queryByText("Sales automation ROI")).toBeNull();
    });
  });

  describe("CL-1889: Open in Myra flow", () => {
    beforeEach(() => {
      mockOpenWithMessage.mockClear();
    });

    it('opens the Myra chat seeded with a reference when "Open in Myra" is clicked in the artifact modal', async () => {
      renderWithSeededArtifacts(
        "tenant-workbench",
        [fakeArtifact],
        React.createElement(ArtifactGallery, { tenantId: "tenant-workbench" }),
      );

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Open Sales automation ROI/i,
        }),
      );
      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: /Open in Myra/i }));

      expect(mockOpenWithMessage).toHaveBeenCalledTimes(1);
    });

    it('closes the modal after clicking "Open in Myra"', async () => {
      renderWithSeededArtifacts(
        "tenant-workbench",
        [fakeArtifact],
        React.createElement(ArtifactGallery, { tenantId: "tenant-workbench" }),
      );

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Open Sales automation ROI/i,
        }),
      );
      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: /Open in Myra/i }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });
  });

  describe("CL-3156: Archive from the gallery modal", () => {
    function renderWithMe(
      me: { isAdmin?: boolean; isOwner?: boolean },
      artifacts: ArtifactWithSession[],
    ) {
      const client = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
            refetchOnMount: false,
          },
        },
      });
      client.setQueryData(
        [
          "artifacts",
          "tenant-workbench",
          "",
          "newest",
          "",
          "",
          "",
          "",
          "",
          "",
          false,
          "infinite",
        ],
        { pages: [{ artifacts, nextCursor: null }], pageParams: [null] },
      );
      client.setQueryData(["members", "tenant-workbench"], []);
      client.setQueryData(["me"], me);
      return render(
        React.createElement(
          ChatLauncherContext.Provider,
          { value: mockContextValue },
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(
              QueryClientProvider,
              { client },
              React.createElement(ArtifactGallery, {
                tenantId: "tenant-workbench",
              }),
            ),
          ),
        ),
      );
    }

    it("optimistically removes the card and POSTs the archive route for an admin", async () => {
      const fetchSpy = mock((input: string | URL | Request) => {
        if (String(input).includes("/archive")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                artifact: {
                  ...fakeArtifact,
                  archivedAt: "2026-07-09T12:00:00.000Z",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ artifacts: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });
      const originalFetch = global.fetch;
      global.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const view = renderWithMe({ isAdmin: true }, [fakeArtifact]);
        fireEvent.click(
          await view.findByRole("button", {
            name: /Open Sales automation ROI/i,
          }),
        );
        await view.findByRole("dialog");
        // Archive is confirm-guarded: arm, then confirm.
        fireEvent.click(view.getByRole("button", { name: "Archive" }));
        fireEvent.click(view.getByRole("button", { name: "Confirm archive" }));
        await waitFor(() =>
          expect(view.queryByText("Sales automation ROI")).toBeNull(),
        );
        expect(
          fetchSpy.mock.calls.some((c) =>
            String(c[0]).includes("/artifacts/a-1/archive"),
          ),
        ).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("does not offer the archive action to a non-owner, non-admin", async () => {
      const view = renderWithMe({ isAdmin: false, isOwner: false }, [
        fakeArtifact,
      ]);
      fireEvent.click(
        await view.findByRole("button", {
          name: /Open Sales automation ROI/i,
        }),
      );
      await view.findByRole("dialog");
      expect(view.queryByRole("button", { name: "Archive" })).toBeNull();
    });
  });
});
