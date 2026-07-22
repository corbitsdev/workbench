import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  CompetitorAnalysisIntakePayloadSchema,
  CompetitorAnalysisReviewPayloadSchema,
} from "./competitor-analysis";

describe("CompetitorAnalysisIntakePayloadSchema", () => {
  test("accepts a valid https companyUrl with optional fields", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      companyUrl: "https://acme.com",
      companyName: "Acme",
      focusNotes: "focus on mid-market CRM",
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.companyUrl).toBe("https://acme.com");
      expect(out.companyName).toBe("Acme");
      expect(out.focusNotes).toBe("focus on mid-market CRM");
    }
  });

  test("accepts a payload with only companyUrl", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      companyUrl: "http://example.com/path",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("rejects a blank companyUrl", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({ companyUrl: "" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a non-http(s) companyUrl", () => {
    const out = CompetitorAnalysisIntakePayloadSchema({
      companyUrl: "ftp://example.com",
    });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a missing companyUrl", () => {
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
