import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Badge, badgeVariants } from "./Badge";

afterEach(cleanup);

describe("badgeVariants", () => {
  it("defaults to the neutral tone", () => {
    const classes = badgeVariants({});
    expect(classes).toContain("bg-surface-2");
    expect(classes).toContain("text-text-3");
  });

  it("uses Summit Blue tokens for the identity tone", () => {
    const classes = badgeVariants({ tone: "identity" });
    expect(classes).toContain("text-blue");
    expect(classes).toContain("bg-blue/10");
  });

  it("reserves accent (orange) as its own tone", () => {
    expect(badgeVariants({ tone: "accent" })).toContain("text-accent");
  });

  it("maps positive and danger to semantic palette tokens", () => {
    expect(badgeVariants({ tone: "positive" })).toContain("text-green");
    expect(badgeVariants({ tone: "danger" })).toContain("text-red");
  });
});

describe("Badge", () => {
  it("renders its children and merges a caller className", () => {
    render(<Badge className="custom-x">Agent</Badge>);
    const badge = screen.getByText("Agent");
    expect(badge.className).toContain("custom-x");
    expect(badge.className).toContain("uppercase");
  });

  it("applies the requested tone classes to the rendered element", () => {
    render(<Badge tone="identity">User</Badge>);
    expect(screen.getByText("User").className).toContain("text-blue");
  });
});
