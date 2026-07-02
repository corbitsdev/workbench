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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: { origin: "workflow" },
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
    ["artifacts", tenantId, "", "newest", "", "", "", "", ""],
    artifacts,
  );
  client.setQueryData(["members", tenantId], []);
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
});
