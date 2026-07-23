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
import { ArtifactGalleryToolbar } from "./ArtifactGallery";

afterEach(cleanup);

const artifact: ArtifactWithSession = {
  id: "a-1",
  parentId: null,
  kind: "email",
  title: "Sales automation ROI",
  content: "body",
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

describe("ArtifactGalleryToolbar", () => {
  it("renders the title and item count from the provided artifacts", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, { artifacts: [artifact] }),
    );
    expect(screen.getByText("Artifacts")).toBeDefined();
    expect(screen.getByText("1 items")).toBeDefined();
  });

  it("shows the '+' item count suffix when hasMore is set", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        hasMore: true,
      }),
    );
    expect(screen.getByText("1+ items")).toBeDefined();
  });

  it("calls onQueryChange with the input value as the user types", () => {
    const onQueryChange = mock((_q: string) => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        onQueryChange,
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search artifacts"), {
      target: { value: "roi" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("roi");
  });

  it("toggles sort order and calls onSortChange when controlled", () => {
    const onSortChange = mock((_s: "newest" | "oldest") => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        sort: "newest",
        onSortChange,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort oldest first" }));
    expect(onSortChange).toHaveBeenCalledWith("oldest");
  });

  it("manages its own sort state when uncontrolled", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, { artifacts: [artifact] }),
    );
    expect(screen.getByText("Newest")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sort oldest first" }));
    expect(screen.getByText("Oldest")).toBeDefined();
  });

  it("fires onNew from the Add button", () => {
    const onNew = mock(() => {});
    render(
      React.createElement(ArtifactGalleryToolbar, { artifacts: [], onNew }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("renders the owner filter dropdown when multiple owners are provided", async () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    const onOwnerFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
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

  it("does not render the owner dropdown when fewer than two owners are provided", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        owners: [{ id: "p-1", name: "Alice" }],
        onOwnerFilterChange: mock(() => {}),
      }),
    );
    expect(screen.queryByText("All owners")).toBeNull();
  });

  it("reflects the active owner filter in the trigger label", () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [
          { ...artifact, ownerPrincipalId: "p-1", ownerName: "Alice" },
        ],
        owners,
        ownerPrincipalId: "p-1",
        onOwnerFilterChange: mock(() => {}),
      }),
    );
    screen.getByRole("button", { name: /Alice/ });
    expect(screen.queryByText("All owners")).toBeNull();
  });

  it("calls onOwnerFilterChange when an owner is selected", async () => {
    const owners = [
      { id: "p-1", name: "Alice" },
      { id: "p-2", name: "Bob" },
    ];
    const onOwnerFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
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

  it("renders the type filter menu with distinct kinds from the artifact set", async () => {
    const onKindFilterChange = mock(() => {});
    const artifacts = [artifact, { ...artifact, id: "a-2", kind: "one-pager" }];
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts,
        onKindFilterChange,
      }),
    );
    const trigger = screen.getByRole("button", { name: /All types/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => screen.getByRole("menu"));
    screen.getByRole("menuitem", { name: "Email" });
    screen.getByRole("menuitem", { name: "One-Pager" });
  });

  it("calls onKindFilterChange when a type is selected", async () => {
    const onKindFilterChange = mock(() => {});
    const artifacts = [artifact, { ...artifact, id: "a-2", kind: "one-pager" }];
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts,
        onKindFilterChange,
      }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /All types/ }), {
      key: "ArrowDown",
    });
    const item = await waitFor(() =>
      screen.getByRole("menuitem", { name: "One-Pager" }),
    );
    fireEvent.click(item);
    expect(onKindFilterChange).toHaveBeenCalledWith("one-pager");
  });

  it("does not hide the type dropdown once a single-kind filter is applied", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        kind: "email",
        onKindFilterChange: mock(() => {}),
      }),
    );
    screen.getByRole("button", { name: /Email/ });
  });

  it("renders the creator-kind filter menu and calls the handler on select", async () => {
    const onCreatorKindFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        onCreatorKindFilterChange,
      }),
    );
    const trigger = screen.getByRole("button", { name: /All creators/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = await waitFor(() =>
      screen.getByRole("menuitem", { name: "Agent" }),
    );
    fireEvent.click(item);
    expect(onCreatorKindFilterChange).toHaveBeenCalledWith("agent");
  });

  it("reflects the active creator-kind filter in the trigger label", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        creatorKind: "user",
        onCreatorKindFilterChange: mock(() => {}),
      }),
    );
    screen.getByRole("button", { name: /Human/ });
    expect(screen.queryByText("All creators")).toBeNull();
  });

  it("toggles view mode from the header control", () => {
    const onViewModeChange = mock((_m: "grid" | "rows") => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        viewMode: "grid",
        onViewModeChange,
      }),
    );
    fireEvent.click(screen.getByLabelText("Rows view"));
    expect(onViewModeChange).toHaveBeenCalledWith("rows");
  });

  it("hides advanced filter controls until the Filters toggle is opened", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        onAdvancedFilterChange: mock(() => {}),
      }),
    );
    expect(screen.queryByText("From")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Toggle filters/ }));
    screen.getByText("From");
    screen.getByText("To");
  });

  it("emits the merged advanced filter when a date bound changes", () => {
    const onAdvancedFilterChange = mock(() => {});
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        createdAfter: "2026-06-01",
        onAdvancedFilterChange,
      }),
    );
    const toInput = screen
      .getByText("To")
      .querySelector("input") as HTMLInputElement;
    fireEvent.change(toInput, { target: { value: "2026-06-30" } });
    expect(onAdvancedFilterChange).toHaveBeenCalledWith({
      createdAfter: "2026-06-01",
      createdBefore: "2026-06-30",
    });
  });

  it("lets the Filters toggle close the panel while a filter is active", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, {
        artifacts: [artifact],
        createdAfter: "2026-06-01",
        onAdvancedFilterChange: mock(() => {}),
      }),
    );
    const toggle = screen.getByRole("button", { name: /Toggle filters/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    screen.getByText("From");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("From")).toBeNull();
  });

  it("does not render the Filters toggle without an advanced-filter handler", () => {
    render(
      React.createElement(ArtifactGalleryToolbar, { artifacts: [artifact] }),
    );
    expect(screen.queryByRole("button", { name: /Toggle filters/ })).toBeNull();
  });
});
