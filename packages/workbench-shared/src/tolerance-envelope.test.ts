import { describe, expect, test } from "bun:test";
import {
  isToleranceEnvelopeFailure,
  parseToleranceEnvelope,
  toleranceFailureContent,
} from "./tolerance-envelope";

describe("toleranceFailureContent / isToleranceEnvelopeFailure", () => {
  test("builds the canonical failure shape", () => {
    expect(toleranceFailureContent("boom")).toEqual({
      isError: true,
      error: "boom",
    });
  });

  test("recognizes the canonical failure shape and rejects lookalikes", () => {
    expect(isToleranceEnvelopeFailure({ isError: true, error: "boom" })).toBe(
      true,
    );
    expect(isToleranceEnvelopeFailure({ isError: false, error: "boom" })).toBe(
      false,
    );
    expect(isToleranceEnvelopeFailure({ isError: true })).toBe(false);
    expect(isToleranceEnvelopeFailure(null)).toBe(false);
    expect(isToleranceEnvelopeFailure("boom")).toBe(false);
  });
});

describe("parseToleranceEnvelope", () => {
  test("parses a plain-object failure envelope", () => {
    expect(
      parseToleranceEnvelope({ isError: true, error: "no credential" }),
    ).toEqual({ ok: false, error: "no credential" });
  });

  test("parses a JSON-stringified failure envelope (kind:'string' wrappers)", () => {
    expect(
      parseToleranceEnvelope(
        JSON.stringify({ isError: true, error: "429 rate limited" }),
      ),
    ).toEqual({ ok: false, error: "429 rate limited" });
  });

  test("parses a bare successful object payload, unwrapped", () => {
    expect(parseToleranceEnvelope({ notes: [{ id: "n1" }] })).toEqual({
      ok: true,
      data: { notes: [{ id: "n1" }] },
    });
  });

  test("parses a JSON-stringified successful object payload", () => {
    expect(parseToleranceEnvelope(JSON.stringify({ items: [1, 2] }))).toEqual({
      ok: true,
      data: { items: [1, 2] },
    });
  });

  test("treats a non-JSON success string as raw success data", () => {
    expect(parseToleranceEnvelope("plain text result")).toEqual({
      ok: true,
      data: "plain text result",
    });
  });

  test("treats empty string content as an empty success", () => {
    expect(parseToleranceEnvelope("")).toEqual({ ok: true, data: undefined });
  });
});
