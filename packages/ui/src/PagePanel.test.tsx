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

  it("sizes to content instead of forcing full height when fitContent", () => {
    const { container } = render(<PagePanel fitContent>x</PagePanel>);
    const panel = container.querySelector("section");
    // No full-height fill: the frame must not stretch to the viewport, so it
    // ends at the content rather than leaving a dead scrollport below it.
    expect(panel?.className).not.toContain("min-h-full");
    expect(panel?.className).toContain("self-start");
    // Still scrolls once content exceeds the available height.
    expect(panel?.className).toContain("max-h-full");
    expect(panel?.className).toContain("overflow-y-auto");
  });

  it("fitContent overrides scroll={false} clipping", () => {
    const { container } = render(
      <PagePanel fitContent scroll={false}>
        x
      </PagePanel>,
    );
    expect(container.querySelector("section")?.className).not.toContain(
      "overflow-hidden",
    );
  });

  it("drops the shadow when flat", () => {
    const { container } = render(<PagePanel flat>x</PagePanel>);
    expect(container.querySelector("section")?.className).not.toContain(
      "shadow-[",
    );
  });
});
