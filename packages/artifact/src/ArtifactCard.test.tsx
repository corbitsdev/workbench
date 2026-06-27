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
  from: "Acme Corp",
  time: "2 hours ago",
  provenance: "Workflow",
  label: "Email",
  viz: "lines",
  fill: "bg-orange",
  span: "row-span-3",
};

describe("ArtifactCard", () => {
  it("renders the type label, from, time, and a zero-padded index badge", () => {
    render(React.createElement(ArtifactCard, { artifact, index: 3 }));
    expect(screen.getByText("Email")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("2 hours ago")).toBeDefined();
    // Badge is the label's first letter plus the padded index: "E03".
    expect(screen.getByText("E03")).toBeDefined();
    // Provenance badge is always surfaced.
    expect(screen.getByText("Workflow")).toBeDefined();
  });

  it("omits the provenance chip for an unknown/legacy source", () => {
    render(
      React.createElement(ArtifactCard, {
        artifact: {
          ...artifact,
          provenance: "Unknown source",
          provenanceTone: "unknown",
        },
        index: 1,
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
        index: 1,
      }),
    );
    const chip = screen.getByText("Last 30 Days");
    expect(chip.className).not.toContain("uppercase");
    expect(chip.className).toContain("truncate");
  });

  it("exposes no button role when onOpen is omitted", () => {
    render(React.createElement(ArtifactCard, { artifact, index: 1 }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("invokes onOpen with the artifact on click", () => {
    const onOpen = mock((_a: GalleryArtifact) => {});
    render(React.createElement(ArtifactCard, { artifact, index: 1, onOpen }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Sales automation ROI" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toBe(artifact);
  });

  it("activates on Enter and Space and suppresses default scrolling", () => {
    const onOpen = mock(() => {});
    render(React.createElement(ArtifactCard, { artifact, index: 1, onOpen }));
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
    render(React.createElement(ArtifactCard, { artifact, index: 1, onOpen }));
    fireEvent.keyDown(screen.getByRole("button"), { key: "a" });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
