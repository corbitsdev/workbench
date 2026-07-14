import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  SumbleIntakePayloadSchema,
  SumbleReviewPayloadSchema,
} from "./sumble-account-intel";

describe("SumbleIntakePayloadSchema", () => {
  test("accepts a non-empty organizationDomain with pushToAttio", () => {
    const out = SumbleIntakePayloadSchema({
      organizationDomain: "acme.com",
      pushToAttio: true,
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.organizationDomain).toBe("acme.com");
      expect(out.pushToAttio).toBe(true);
    }
  });

  test("accepts a payload without the optional pushToAttio flag", () => {
    const out = SumbleIntakePayloadSchema({ organizationDomain: "acme.com" });
    expect(out instanceof type.errors).toBe(false);
  });

  test("rejects an empty organizationDomain", () => {
    const out = SumbleIntakePayloadSchema({ organizationDomain: "   " });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a missing organizationDomain", () => {
    const out = SumbleIntakePayloadSchema({ pushToAttio: false });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("SumbleReviewPayloadSchema", () => {
  test("accepts an approval decision", () => {
    const out = SumbleReviewPayloadSchema({
      approved: true,
      pushToAttio: true,
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.approved).toBe(true);
    }
  });

  test("rejects a payload missing the approved flag", () => {
    const out = SumbleReviewPayloadSchema({ pushToAttio: true });
    expect(out instanceof type.errors).toBe(true);
  });
});
