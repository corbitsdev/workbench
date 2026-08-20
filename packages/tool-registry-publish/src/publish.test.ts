// The publish flow treats a published name@version as IMMUTABLE: a
// filename that already exists in the registry is skipped (same-source
// rebuilds are not byte-deterministic, so differing bytes cannot prove
// changed code) — shipping a change requires a version bump.
import { describe, expect, test } from "bun:test";
import { shouldPublishTarball, sha512Integrity } from "./publish";

describe("shouldPublishTarball", () => {
  test("a brand-new filename publishes", () => {
    expect(shouldPublishTarball("corbits-x-tools-0.0.2.tgz", undefined)).toBe(
      true,
    );
  });

  test("an already-published filename is skipped, whatever its bytes", () => {
    const existing = sha512Integrity(new TextEncoder().encode("old bytes"));
    expect(shouldPublishTarball("corbits-x-tools-0.0.2.tgz", existing)).toBe(
      false,
    );
  });
});

describe("sha512Integrity", () => {
  test("is stable for identical bytes and SRI-shaped", () => {
    const bytes = new TextEncoder().encode("same");
    expect(sha512Integrity(bytes)).toBe(sha512Integrity(bytes));
    expect(sha512Integrity(bytes).startsWith("sha512-")).toBe(true);
  });
});
