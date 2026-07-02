/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { ArtifactViz } from "./ArtifactViz";
import type { VizKind } from "./types";

afterEach(cleanup);

function renderViz(kind: VizKind): SVGSVGElement {
  const { container } = render(React.createElement(ArtifactViz, { kind }));
  const svg = container.querySelector("svg");
  if (!svg) throw new Error(`ArtifactViz rendered no <svg> for kind "${kind}"`);
  return svg;
}

describe("ArtifactViz", () => {
  it("renders four bars for the bars kind", () => {
    expect(renderViz("bars").querySelectorAll("rect").length).toBe(4);
  });

  it("renders two concentric rings for the donut kind", () => {
    expect(renderViz("donut").querySelectorAll("circle").length).toBe(2);
  });

  it("renders a 15-cell grid for the grid kind", () => {
    expect(renderViz("grid").querySelectorAll("rect").length).toBe(15);
  });

  it("renders five line bars for the lines kind", () => {
    expect(renderViz("lines").querySelectorAll("rect").length).toBe(5);
  });

  it("renders connected nodes for the nodes kind", () => {
    const svg = renderViz("nodes");
    expect(svg.querySelectorAll("circle").length).toBe(4);
    expect(svg.querySelectorAll("line").length).toBe(3);
  });

  it("renders a 24-cell heatmap for the heat kind", () => {
    expect(renderViz("heat").querySelectorAll("rect").length).toBe(24);
  });

  it("renders stacked slide shapes for the deck kind", () => {
    expect(renderViz("deck").querySelectorAll("rect").length).toBe(5);
  });

  it("renders a 14-cell calendar for the cal kind", () => {
    expect(renderViz("cal").querySelectorAll("rect").length).toBe(14);
  });
});

import { toGalleryArtifact, visualForKind } from "./artifact-visuals";
import type { ArtifactWithSession } from "@workbench/shared";

const baseArtifact: ArtifactWithSession = {
  id: "a-1",
  parentId: null,
  kind: "email",
  title: "Outreach",
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

describe("artifact-visuals", () => {
  it("falls back to a neutral document visual for unknown kinds", () => {
    expect(visualForKind("something-unknown")).toEqual({
      label: "Document",
      viz: "lines",
      fill: "bg-cream",
      span: "row-span-3",
      experimentalFill: "bg-cream",
      experimentalSpan: "row-span-3",
    });
  });

  it("uses the web visual for single-file HTML artifacts", () => {
    expect(visualForKind("web")).toMatchObject({
      label: "Web",
      viz: "deck",
      fill: "bg-blue",
    });
  });

  it("yields an empty time string for an unparseable updatedAt", () => {
    const gallery = toGalleryArtifact({
      ...baseArtifact,
      updatedAt: "not-a-date",
    });
    expect(gallery.time).toBe("");
  });

  it('falls back to "Untitled job" when the session has no name', () => {
    const gallery = toGalleryArtifact({ ...baseArtifact, sessionName: null });
    expect(gallery.from).toBe("Untitled job");
  });
});
