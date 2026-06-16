import { describe, expect, it } from "bun:test";
import { buildActiveContext, formatDate, withActiveContext } from "./index";

describe("formatDate", () => {
  it("formats the UTC date as DD/MM/YYYY with zero padding", () => {
    expect(formatDate(new Date("2026-06-14T09:30:00Z"))).toBe("14/06/2026");
    expect(formatDate(new Date("2026-01-05T00:00:00Z"))).toBe("05/01/2026");
  });

  it("uses the UTC calendar date, not local time", () => {
    expect(formatDate(new Date("2026-12-31T23:30:00Z"))).toBe("31/12/2026");
  });
});

describe("buildActiveContext", () => {
  it("renders the date alone when no user or extras are present", () => {
    expect(buildActiveContext({ now: new Date("2026-06-14T00:00:00Z") })).toBe(
      "## Active Context\nCurrent date: 14/06/2026",
    );
  });

  it("includes the user name above the date when present", () => {
    const block = buildActiveContext({
      now: new Date("2026-06-14T00:00:00Z"),
      userName: "Sawyer",
    });
    expect(block).toContain("User: Sawyer");
    expect(block.indexOf("User: Sawyer")).toBeLessThan(block.indexOf("Current date:"));
  });

  it("renders extra labelled facts in insertion order", () => {
    const block = buildActiveContext({
      now: new Date("2026-06-14T00:00:00Z"),
      extra: { Workbench: "GTM", Timezone: "UTC" },
    });
    expect(block.indexOf("Workbench: GTM")).toBeLessThan(block.indexOf("Timezone: UTC"));
  });
});

describe("withActiveContext", () => {
  it("appends the block beneath the existing prompt without altering it", () => {
    const result = withActiveContext("You are Myra.", { now: new Date("2026-06-14T00:00:00Z") });
    expect(result.startsWith("You are Myra.")).toBe(true);
    expect(result.endsWith("Current date: 14/06/2026")).toBe(true);
  });
});
