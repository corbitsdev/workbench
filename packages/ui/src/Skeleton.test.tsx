import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Skeleton } from "./Skeleton";

afterEach(cleanup);

describe("Skeleton", () => {
  it("renders a token-driven shimmer surface", () => {
    render(<Skeleton />);
    const el = screen.getByTestId("skeleton");
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("bg-surface-2");
  });

  it("is hidden from assistive tech so a live region announces instead", () => {
    render(<Skeleton />);
    expect(screen.getByTestId("skeleton").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("merges caller sizing/shape classes over the defaults", () => {
    render(<Skeleton className="h-10 w-full rounded-full" />);
    const el = screen.getByTestId("skeleton");
    expect(el.className).toContain("h-10");
    expect(el.className).toContain("rounded-full");
    // twMerge drops the default radius when the caller sets one.
    expect(el.className).not.toContain("rounded-[8px]");
  });
});
