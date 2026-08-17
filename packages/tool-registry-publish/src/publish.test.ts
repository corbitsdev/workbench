import { describe, expect, test } from "bun:test";
import {
  assertNoVersionCollision,
  sha512Integrity,
  TarballVersionCollisionError,
} from "./publish";

describe("assertNoVersionCollision", () => {
  test("allows a filename with no existing entry", () => {
    const bytes = new TextEncoder().encode("tarball-bytes");
    expect(() =>
      assertNoVersionCollision("foo-0.0.2.tgz", bytes, undefined),
    ).not.toThrow();
  });

  test("allows re-publishing byte-identical content under the same filename", () => {
    const bytes = new TextEncoder().encode("tarball-bytes");
    expect(() =>
      assertNoVersionCollision(
        "foo-0.0.2.tgz",
        bytes,
        sha512Integrity(bytes),
      ),
    ).not.toThrow();
  });

  test("fails loudly when the same filename would carry different content", () => {
    const oldBytes = new TextEncoder().encode("old-tarball-bytes");
    const newBytes = new TextEncoder().encode("new-tarball-bytes");
    expect(() =>
      assertNoVersionCollision(
        "foo-0.0.2.tgz",
        newBytes,
        sha512Integrity(oldBytes),
      ),
    ).toThrow(TarballVersionCollisionError);
  });

  test("collision error names the filename and tells the caller to bump the version", () => {
    const oldBytes = new TextEncoder().encode("old");
    const newBytes = new TextEncoder().encode("new");
    try {
      assertNoVersionCollision(
        "foo-0.0.2.tgz",
        newBytes,
        sha512Integrity(oldBytes),
      );
      throw new Error("expected assertNoVersionCollision to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TarballVersionCollisionError);
      expect((err as Error).message).toContain("foo-0.0.2.tgz");
      expect((err as Error).message).toContain("bump");
    }
  });
});
