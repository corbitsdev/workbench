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
  viz: "lines",
  fill: "bg-orange",
  span: "row-span-3",
  status: "draft",
  previewExcerpt: "Quick follow-up on our call",
};

describe("ArtifactCard", () => {
  it("renders the type label, from, and time", () => {
    render(React.createElement(ArtifactCard, { artifact }));
    expect(screen.getByText("Email")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("2 hours ago")).toBeDefined();
    // Provenance badge is always surfaced.
    expect(screen.getByText("Workflow")).toBeDefined();
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

  it("omits the provenance chip for an unknown/legacy source", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          provenance: "Unknown source",
          provenanceTone: "unknown",
        },
      }),
    );
    expect(screen.queryByText("Unknown source")).toBeNull();
  });

  it("does not uppercase free-text provenance", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          provenance: "Last 30 Days",
          provenanceTone: "free",
        },
      }),
    );
    const chip = screen.getByText("Last 30 Days");
    expect(chip.className).not.toContain("uppercase");
    expect(chip.className).toContain("truncate");
  });

  it("renders solid fill hero on default gallery cards, without a Draft badge", () => {
    const { container } = render(
      React.createElement(ArtifactCard, { artifact }),
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.getAttribute("data-preview-family")).toBe("email");
    // status is "draft" — the default, non-signal state — so no badge.
    expect(screen.queryByText("Draft")).toBeNull();
    expect(card.querySelector("pre")).toBeNull();
    expect(screen.queryByText("Quick follow-up on our call")).toBeNull();
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

  it("renders ArtifactViz in the hero on default cards even when an excerpt exists", () => {
    const { container } = render(
      React.createElement(ArtifactCard, { artifact }),
    );
    const preview = container.querySelector('[class*="min-h-[120px]"]');
    expect(screen.queryByText("Quick follow-up on our call")).toBeNull();
    expect(preview?.querySelector("svg")).not.toBeNull();
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

  it("styles approved status with workbench green tokens and shows the badge", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: { ...artifact, status: "approved" },
      }),
    );
    const approved = screen.getByText("Approved");
    expect(approved.className).toContain("bg-green/10");
    expect(approved.className).toContain("text-green");
  });

  it("shows the Rejected badge for a rejected artifact", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: { ...artifact, status: "rejected" },
      }),
    );
    const rejected = screen.getByText("Rejected");
    expect(rejected.className).toContain("text-red");
  });

  it("shows the status badge in the experimental overlay only for a non-draft status", () => {
    const { rerender } = render(
      React.createElement(ArtifactCard, { artifact, experimental: true }),
    );
    expect(screen.queryByText("Draft")).toBeNull();
    rerender(
      React.createElement(ArtifactCard, {
        artifact: { ...artifact, status: "approved" },
        experimental: true,
      }),
    );
    expect(screen.getByText("Approved")).toBeDefined();
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
});
