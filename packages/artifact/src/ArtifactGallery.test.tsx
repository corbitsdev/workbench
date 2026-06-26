/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import React from "react";
import type { ArtifactWithSession } from "@workbench/shared";
import { ArtifactGallery } from "./ArtifactGallery";
import { ArtifactCard } from "./ArtifactCard";
import { toGalleryArtifact } from "./artifact-visuals";

afterEach(cleanup);

const artifact: ArtifactWithSession = {
  id: "a-1",
  sessionId: "wf-1",
  parentId: null,
  painPointId: "p-1",
  kind: "email",
  title: "Sales automation ROI",
  content: "body",
  status: "approved",
  version: 1,
  ownerPrincipalId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
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
    expect(screen.getByText("1 items")).toBeDefined();
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

  it("fires onNew from the New button", () => {
    const onNew = mock(() => {});
    render(React.createElement(ArtifactGallery, { artifacts: [], onNew }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("renders the owner filter dropdown when multiple owners are provided", async () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    const onOwnerFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        owners,
        onOwnerFilterChange,
      }),
    );
    const trigger = screen.getByRole("button", { name: /All owners/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => screen.getByRole("menu"));
    screen.getByRole("menuitem", { name: "Alice" });
    screen.getByRole("menuitem", { name: "Bob" });
  });

  it("does not render the dropdown when fewer than two owners are provided", () => {
    const onOwnerFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        owners: [{ id: "p-1", name: "Alice" }],
        onOwnerFilterChange,
      }),
    );
    expect(screen.queryByText("All owners")).toBeNull();
  });

  it("does not render the dropdown when owners is undefined", () => {
    const onOwnerFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        onOwnerFilterChange,
      }),
    );
    expect(screen.queryByText("All owners")).toBeNull();
  });

  it("reflects the active owner filter in the trigger label", () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    const onOwnerFilterChange = mock(() => {});
    const filteredArtifacts = [
      { ...artifact, ownerPrincipalId: "p-1", ownerName: "Alice" },
    ];
    render(
      React.createElement(ArtifactGallery, {
        artifacts: filteredArtifacts,
        owners,
        ownerPrincipalId: "p-1",
        onOwnerFilterChange,
      }),
    );
    screen.getByRole("button", { name: /Alice/ });
    expect(screen.queryByText("All owners")).toBeNull();
  });

  it("sources the owner list from the owners prop, not the filtered artifacts", async () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    const onOwnerFilterChange = mock(() => {});
    const filteredArtifacts = [
      { ...artifact, ownerPrincipalId: "p-1", ownerName: "Alice" },
    ];
    render(
      React.createElement(ArtifactGallery, {
        artifacts: filteredArtifacts,
        owners,
        ownerPrincipalId: "p-1",
        onOwnerFilterChange,
      }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /Alice/ }), {
      key: "ArrowDown",
    });
    await waitFor(() => screen.getByRole("menu"));
    screen.getByRole("menuitem", { name: "Alice" });
    screen.getByRole("menuitem", { name: "Bob" });
  });

  it("calls onOwnerFilterChange when an owner is selected", async () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    const onOwnerFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGallery, {
        artifacts: [artifact],
        owners,
        onOwnerFilterChange,
      }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /All owners/ }), {
      key: "ArrowDown",
    });
    const item = await waitFor(() =>
      screen.getByRole("menuitem", { name: "Alice" }),
    );
    fireEvent.click(item);
    expect(onOwnerFilterChange).toHaveBeenCalledWith("p-1");
  });
});
