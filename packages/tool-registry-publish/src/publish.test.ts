// The publish flow treats a published name@version as IMMUTABLE: a
// filename that already exists in the registry is skipped (same-source
// rebuilds are not byte-deterministic, so differing bytes cannot prove
// changed code) — shipping a change requires a version bump.
import { describe, expect, test } from "bun:test";
import {
  EmptyRegistryPublishError,
  publishCorbitsToolsRegistry,
  shouldPublishTarball,
  sha512Integrity,
  type ApiCall,
} from "./publish";
import { tarballsCoverRequiredSeedPackages } from "./registry";

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

describe("tarballsCoverRequiredSeedPackages", () => {
  test("an empty listing is not seeded", () => {
    expect(tarballsCoverRequiredSeedPackages([])).toBe(false);
  });

  test("covers @corbits/memory-tools at any version", () => {
    expect(
      tarballsCoverRequiredSeedPackages(["corbits-memory-tools-0.0.4.tgz"]),
    ).toBe(true);
  });

  test("a dangling registry with unrelated tarballs is not seeded", () => {
    expect(
      tarballsCoverRequiredSeedPackages(["corbits-other-tools-1.0.0.tgz"]),
    ).toBe(false);
  });
});

describe("publishCorbitsToolsRegistry", () => {
  test("success is false when zero packages are uploaded onto an empty registry", async () => {
    let createdAssets = 0;
    const api: ApiCall = async (method, path) => {
      if (
        method === "GET" &&
        path.includes("kind=package-registry") &&
        path.includes("inherited=false")
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (method === "POST" && path.endsWith("/assets")) {
        createdAssets += 1;
        return { status: 201, data: {}, cookies: [] };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    try {
      await publishCorbitsToolsRegistry({
        api,
        cookies: [],
        hubUrl: "http://localhost:3000",
        tenantId: "ten_1",
        checkFreshness: async () => undefined,
        packageDirs: [],
      });
      throw new Error("expected EmptyRegistryPublishError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(EmptyRegistryPublishError);
      expect((cause as EmptyRegistryPublishError).success).toBe(false);
    }
    expect(createdAssets).toBe(0);
  });
});
