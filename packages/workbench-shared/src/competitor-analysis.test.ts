import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  CompetitorAnalysisIntakePayloadSchema,
  CompetitorAnalysisReviewPayloadSchema,
} from "./competitor-analysis";

describe("CompetitorAnalysisIntakePayloadSchema", () => {
  test("accepts a valid https url with optional fields", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      url: "https://acme.com",
      companyName: "Acme",
      focusNotes: "focus on mid-market CRM",
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.url).toBe("https://acme.com");
      expect(out.companyName).toBe("Acme");
      expect(out.focusNotes).toBe("focus on mid-market CRM");
    }
  });

  test("accepts a payload with only url", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      url: "http://example.com/path",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("rejects a blank url", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({ url: "" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a non-http(s) url", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      url: "ftp://example.com",
    });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a missing url", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      companyName: "Acme",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("CompetitorAnalysisReviewPayloadSchema", () => {
  test("accepts an approval decision", () => {
    const out = CompetitorAnalysisReviewPayloadSchema({ approved: true });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.approved).toBe(true);
    }
  });

  test("rejects a payload missing the approved flag", () => {
    const out = CompetitorAnalysisReviewPayloadSchema({});
    expect(out instanceof type.errors).toBe(true);
  });
});
