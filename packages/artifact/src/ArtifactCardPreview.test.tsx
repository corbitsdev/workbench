/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { ArtifactCardPreview } from "./ArtifactCardPreview";
import { ARTIFACT_PREVIEW_FAMILIES } from "./artifact-preview-family";

afterEach(cleanup);

describe("ArtifactCardPreview", () => {
  it("renders a distinct root for each preview family", () => {
    for (const family of ARTIFACT_PREVIEW_FAMILIES) {
      const { container } = render(
        React.createElement(ArtifactCardPreview, {
          family,
          fill: "bg-blue-500",
          excerpt: "Sample excerpt",
        }),
      );
      expect(container.innerHTML.length).toBeGreaterThan(20);
      expect(container.querySelector("pre")).toBeNull();
    }
  });

  it("does not echo raw JSON in comparison previews", () => {
    const { container } = render(
      React.createElement(ArtifactCardPreview, {
        family: "comparison",
        fill: "bg-amber-500",
      }),
    );
    expect(container.innerHTML).toContain("grid-cols-2");
    expect(container.textContent).not.toContain("{");
  });

  it("shows the winner summary line on a comparison preview when an excerpt is supplied", () => {
    const { getByText } = render(
      React.createElement(ArtifactCardPreview, {
        family: "comparison",
        fill: "bg-amber-500",
        excerpt: "Winner: Claude Opus · 4 variants",
      }),
    );
    expect(getByText("Winner: Claude Opus · 4 variants")).toBeDefined();
  });

  it("never renders an iframe, for any preview family", () => {
    for (const family of ARTIFACT_PREVIEW_FAMILIES) {
      const { container, unmount } = render(
        React.createElement(ArtifactCardPreview, {
          family,
          fill: "bg-blue-500",
          excerpt: "Sample excerpt",
        }),
      );
      expect(container.querySelector("iframe")).toBeNull();
      unmount();
    }
  });

  it("renders the globe-family web preview (label chrome, not an iframe) for the web family", () => {
    const { container } = render(
      React.createElement(ArtifactCardPreview, {
        family: "web",
        fill: "bg-blue-500",
        excerpt: "example.com — a landing page",
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("example.com — a landing page");
  });
});
