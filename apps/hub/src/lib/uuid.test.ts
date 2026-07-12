import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { isUuid, UuidParam } from "./uuid";

describe("UuidParam", () => {
  it("accepts a well-formed UUID", () => {
    const result = UuidParam("11111111-1111-4111-8111-111111111111");
    expect(result instanceof type.errors).toBe(false);
  });

  it("rejects a non-UUID string", () => {
    const result = UuidParam("not-a-uuid");
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("isUuid", () => {
  it("is true for a well-formed UUID", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("is false for a malformed value", () => {
    expect(isUuid("sch-1")).toBe(false);
  });
});
