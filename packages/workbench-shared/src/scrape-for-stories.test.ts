import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { ScrapeForStoriesIntakePayloadSchema } from "./scrape-for-stories";

describe("ScrapeForStoriesIntakePayloadSchema", () => {
  it("accepts one or more non-blank topics", () => {
    const out = ScrapeForStoriesIntakePayloadSchema({
      topics: ["AI coding agents", "GTM automation"],
    });
    expect(out).toEqual({ topics: ["AI coding agents", "GTM automation"] });
  });

  it("rejects an empty topics array — a schedule that searches nothing", () => {
    expect(
      ScrapeForStoriesIntakePayloadSchema({ topics: [] }) instanceof
        type.errors,
    ).toBe(true);
  });

  it("rejects a blank topic entry", () => {
    expect(
      ScrapeForStoriesIntakePayloadSchema({ topics: ["  "] }) instanceof
        type.errors,
    ).toBe(true);
  });

  it("rejects a missing topics field", () => {
    expect(ScrapeForStoriesIntakePayloadSchema({}) instanceof type.errors).toBe(
      true,
    );
  });
});
