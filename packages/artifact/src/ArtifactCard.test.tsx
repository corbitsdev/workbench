/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ArtifactCard } from "./ArtifactCard";
import type { GalleryArtifact } from "./types";

afterEach(cleanup);

const artifact: GalleryArtifact = {
  id: "a-1",
  title: "Sales automation ROI",
  kind: "email",
  from: "Acme Corp",
  time: "2 hours ago",
  provenance: "Workflow",
  label: "Email",
  fill: "bg-orange",
  span: "row-span-3",
  previewExcerpt: "Quick follow-up on our call",
};

describe("ArtifactCard", () => {
  it("renders title, from, and time — no kind label chrome", () => {
    render(React.createElement(ArtifactCard, { artifact }));
    expect(screen.getByText("Sales automation ROI")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("2 hours ago")).toBeDefined();
    // The kind label ("Email") no longer renders as card chrome.
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("renders no decorative position badge markup", () => {
    const { container } = render(
      React.createElement(ArtifactCard, { artifact }),
    );
    // The removed badge was the label's first letter + a zero-padded index
    // (e.g. "E03"). No element should carry that pattern as its sole text.
    for (const el of Array.from(container.querySelectorAll("span"))) {
      expect(el.textContent ?? "").not.toMatch(/^[A-Z]\d{2}$/);
    }
  });

  it("never renders the origin/provenance chip, for any tone", () => {
    for (const [provenance, provenanceTone] of [
      ["Workflow", "origin"],
      ["Agent", "origin"],
      ["Imported", "origin"],
      ["Unknown source", "unknown"],
      ["Last 30 Days", "free"],
    ] as const) {
      const { unmount } = render(
        React.createElement(ArtifactCard, {
          artifact: { ...artifact, provenance, provenanceTone },
        }),
      );
      expect(screen.queryByText(provenance)).toBeNull();
      unmount();
    }
  });

  it("renders solid fill hero on default gallery cards", () => {
    const { container } = render(
      React.createElement(ArtifactCard, { artifact }),
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.getAttribute("data-preview-family")).toBe("email");
    expect(card.querySelector("pre")).toBeNull();
    expect(card.querySelector(".bg-orange")).not.toBeNull();
  });

  it("omits the `from · time` line entirely when `from` is absent", () => {
    const { from: _from, ...withoutFrom } = artifact;
    render(
      React.createElement(ArtifactCard, {
        artifact: withoutFrom as GalleryArtifact,
      }),
    );
    expect(screen.getByText("2 hours ago")).toBeDefined();
    expect(screen.queryByText("·")).toBeNull();
  });

  it("renders excerpt preview when experimental cards are enabled", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact,
        experimental: true,
      }),
    );
    expect(screen.getByText("Quick follow-up on our call")).toBeDefined();
  });

  it("renders the kind-family preview (not the decorative placeholder) on default gallery cards too, with the excerpt visible", () => {
    render(React.createElement(ArtifactCard, { artifact }));
    expect(screen.getByText("Quick follow-up on our call")).toBeDefined();
  });

  it("never renders an iframe in the card media area, for any kind", () => {
    const kinds: Array<[string, string]> = [
      ["email", "Email"],
      ["ab-comparison", "Comparison"],
      ["web", "Web page"],
      ["one-pager", "One-Pager"],
    ];
    for (const [kind, label] of kinds) {
      const { container, unmount } = render(
        React.createElement(ArtifactCard, {
          artifact: { ...artifact, kind, label },
        }),
      );
      expect(container.querySelector("iframe")).toBeNull();
      unmount();
    }
  });

  it("renders image thumbnails on default gallery cards", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          kind: "image",
          label: "Image",
          thumbnailUrl: "https://example.test/image.png",
          thumbnailAlt: "Uploaded image",
        },
      }),
    );

    const thumbnail = screen.getByRole("img", { name: "Uploaded image" });
    expect(thumbnail.getAttribute("src")).toBe(
      "https://example.test/image.png",
    );
  });

  it("carries the kind-correct preview family attribute, without rendering any kind-label text", () => {
    const { container } = render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          kind: "image",
          label: "Image",
          thumbnailUrl: "https://example.test/image.png",
          thumbnailAlt: "Uploaded image",
        },
      }),
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.getAttribute("data-preview-family")).toBe("data");
    expect(screen.queryByText("Image")).toBeNull();
    expect(screen.queryByText("Document")).toBeNull();
  });

  it("shows the winner and variant count on a comparison card", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          kind: "ab-comparison",
          label: "Comparison",
          previewExcerpt: "Winner: Claude Opus · 2 variants",
        },
      }),
    );
    expect(screen.getByText("Winner: Claude Opus · 2 variants")).toBeDefined();
  });

  it("falls back to the shaped placeholder when the thumbnail fails to load", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          kind: "image",
          label: "Image",
          thumbnailUrl: "https://example.test/broken.png",
          thumbnailAlt: "Uploaded image",
        },
      }),
    );
    fireEvent.error(screen.getByRole("img", { name: "Uploaded image" }));
    // The broken image is replaced by the deterministic placeholder — neither
    // the <img> nor the browser's broken-image glyph is left in the card.
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("honors experimental fill and span overrides", () => {
    const { container } = render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          experimentalFill: "bg-orange/85",
          experimentalSpan: "row-span-2",
        },
        experimental: true,
      }),
    );
    const card = container.firstElementChild as HTMLElement;
    const viz = card.querySelector(".bg-orange\\/85");

    expect(card.className).toContain("hover:-translate-y-1");
    expect(card.className).toContain("row-span-2");
    expect(viz).not.toBeNull();
  });

  it("exposes no button role when onOpen is omitted", () => {
    render(React.createElement(ArtifactCard, { artifact }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("invokes onOpen with the artifact on click", () => {
    const onOpen = mock((_a: GalleryArtifact) => {});
    render(React.createElement(ArtifactCard, { artifact, onOpen }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Sales automation ROI" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toBe(artifact);
  });

  it("activates on Enter and Space and suppresses default scrolling", () => {
    const onOpen = mock(() => {});
    render(React.createElement(ArtifactCard, { artifact, onOpen }));
    const card = screen.getByRole("button");

    const enter = fireEvent.keyDown(card, { key: "Enter" });
    const space = fireEvent.keyDown(card, { key: " " });

    expect(onOpen).toHaveBeenCalledTimes(2);
    // preventDefault returns false when default was prevented.
    expect(enter).toBe(false);
    expect(space).toBe(false);
  });

  it("ignores other keys", () => {
    const onOpen = mock(() => {});
    render(React.createElement(ArtifactCard, { artifact, onOpen }));
    fireEvent.keyDown(screen.getByRole("button"), { key: "a" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders a creator-initials badge for a non-own artifact", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: { ...artifact, creatorInitials: "SC" },
      }),
    );
    expect(screen.getByText("SC")).toBeDefined();
  });

  it("renders no creator-initials badge when the field is absent (viewer's own artifact)", () => {
    render(React.createElement(ArtifactCard, { artifact }));
    expect(screen.queryByLabelText(/Created by/)).toBeNull();
  });
});
