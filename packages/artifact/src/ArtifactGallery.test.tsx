/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type { ArtifactWithSession } from "@workbench/shared";
import { ArtifactGallery } from "./ArtifactGallery";
import { ArtifactCard } from "./ArtifactCard";
import { toGalleryArtifact } from "./artifact-visuals";

afterEach(cleanup);

const artifact: ArtifactWithSession = {
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

describe("ArtifactCard", () => {
  it("renders title and from label", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: toGalleryArtifact(artifact),
        index: 1,
      }),
    );
    expect(screen.getByText("Sales automation ROI")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
  });

  it("invokes onOpen when activated", () => {
    const onOpen = mock(() => {});
    render(
      React.createElement(ArtifactCard, {
        artifact: toGalleryArtifact(artifact),
        index: 1,
        onOpen,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Open Sales automation ROI/ }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("ArtifactGallery", () => {
  it("renders provided artifacts as tiles", () => {
    render(React.createElement(ArtifactGallery, { artifacts: [artifact] }));
    expect(screen.getByText("Sales automation ROI")).toBeDefined();
  });

  it("shows Load more when hasMore and invokes onLoadMore", () => {
    const onLoadMore = mock(() => {});
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        hasMore: true,
        onLoadMore,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("shows loadMoreError above the load-more button", () => {
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        hasMore: true,
        onLoadMore: () => {},
        loadMoreError: "Network failed",
      }),
    );
    expect(screen.getByText("Network failed")).toBeDefined();
    expect(screen.getByRole("button", { name: "Load more" })).toBeDefined();
  });

  it("does not declare its own panel frame (single PagePanel frame owns it)", () => {
    const { container } = render(
      React.createElement(ArtifactGallery, { artifacts: [artifact] }),
    );
    const root = container.querySelector("section");
    if (!root) throw new Error("gallery root section not rendered");
    expect(root.className).not.toContain("rounded-panel");
    expect(root.className).not.toContain("border-border");
    expect(root.className).not.toContain("bg-bg");
    expect(root.className).not.toContain("shadow-");
  });

  it("shows the loading state", () => {
    render(
      React.createElement(ArtifactGallery, { artifacts: [], isLoading: true }),
    );
    expect(screen.getByText("Loading artifacts…")).toBeDefined();
  });

  it("shows the empty state when there are no artifacts", () => {
    render(React.createElement(ArtifactGallery, { artifacts: [] }));
    expect(screen.getByText(/No artifacts yet/)).toBeDefined();
  });

  it("shows the searching empty state when a query yields no results", () => {
    render(
      React.createElement(ArtifactGallery, { artifacts: [], query: "zzz" }),
    );
    expect(screen.getByText(/No results for/)).toBeDefined();
  });

  it("renders a rows table with column headers when viewMode is rows", () => {
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [{ ...artifact, ownerName: "Alice" }],
        viewMode: "rows",
      }),
    );
    screen.getByRole("table");
    screen.getByRole("columnheader", { name: "Kind" });
    screen.getByRole("columnheader", { name: "Owner" });
    screen.getByRole("cell", { name: "Email" });
    screen.getByRole("cell", { name: "Alice" });
  });

  it("renders the grid (no table) when viewMode is grid", () => {
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        viewMode: "grid",
      }),
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("opens the mapped artifact from a rows-view row click", () => {
    const onOpen = mock((_a: { id: string }) => {});
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        viewMode: "rows",
        onOpen,
      }),
    );
    fireEvent.click(screen.getByText("Sales automation ROI"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]?.id).toBe("a-1");
  });
});
