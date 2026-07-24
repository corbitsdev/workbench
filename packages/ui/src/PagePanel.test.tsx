import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { PagePanel } from "./PagePanel";

describe("PagePanel", () => {
  it("renders children inside the bordered panel", () => {
    const { getByText, container } = render(
      <PagePanel>
        <p>content</p>
      </PagePanel>,
    );
    getByText("content");
    const panel = container.querySelector("section");
    expect(panel?.className).not.toContain("rounded-panel");
    expect(panel?.className).toContain("border");
  });

  it("scrolls by default and clips overflow when scroll is false", () => {
    const scrolling = render(<PagePanel>x</PagePanel>);
    expect(scrolling.container.querySelector("section")?.className).toContain(
      "overflow-y-auto",
    );

    const clipped = render(<PagePanel scroll={false}>x</PagePanel>);
    expect(clipped.container.querySelector("section")?.className).toContain(
      "overflow-hidden",
    );
  });

  it("drops the shadow when flat", () => {
    const { container } = render(<PagePanel flat>x</PagePanel>);
    expect(container.querySelector("section")?.className).not.toContain(
      "shadow-[",
    );
  });

  it("sizes to content instead of filling the viewport when fitContent", () => {
    const { container } = render(
      <PagePanel scroll={false} flat fitContent>
        x
      </PagePanel>,
    );
    const panel = container.querySelector("section");
    // Content-based sizing: no flex-1 (which forces full-viewport height),
    // but capped at the viewport with self-start so it can still scroll.
    expect(panel?.className).not.toContain("flex-1");
    expect(panel?.className).toContain("self-start");
    expect(panel?.className).toContain("max-h-full");
    expect(panel?.className).toContain("w-full");
  });

  it("fills with bg-bg by default and bg-surface when nested in a surface that already has its own background", () => {
    const defaultPanel = render(<PagePanel>x</PagePanel>);
    const defaultSection = defaultPanel.container.querySelector("section");
    expect(defaultSection?.className).toContain("bg-bg");
    expect(defaultSection?.className).not.toContain("bg-surface");

    const nested = render(<PagePanel surface="surface">x</PagePanel>);
    const nestedSection = nested.container.querySelector("section");
    expect(nestedSection?.className).toContain("bg-surface");
    expect(nestedSection?.className).not.toContain("bg-bg");
  });

  it("drops the border in fitContent so a shortened panel leaves no floating edge", () => {
    const { container } = render(
      <PagePanel scroll={false} flat fitContent>
        x
      </PagePanel>,
    );
    const panel = container.querySelector("section");
    expect(panel?.className).not.toContain("border-border");
    // Default (non-fit) panel keeps its framing border.
    const framed = render(<PagePanel>x</PagePanel>);
    expect(framed.container.querySelector("section")?.className).toContain(
      "border-border",
    );
  });
});
