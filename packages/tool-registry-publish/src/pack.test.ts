import { describe, expect, test } from "bun:test";
import * as tar from "tar";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CORBITS_TOOL_PACKAGE_DIRS, CORBITS_TOOLS_REGISTRY } from "./registry";
import { packToolPackageTarball, tarballFilenameFor } from "./pack";

// The kind handler's filename rule
// (vendor/intx/hub-sessions/src/package-registry-kind.ts
// `TARBALL_FILENAME_PATTERN`) — duplicated here so this test fails the
// moment a packed filename would be rejected by the substrate, without
// importing across the vendor boundary.
const TARBALL_FILENAME_PATTERN = /^[A-Za-z0-9_@+][A-Za-z0-9_.@+-]*\.tgz$/;

describe("tarballFilenameFor", () => {
  test("flattens a scoped package name and matches the registry's filename rule", () => {
    const filename = tarballFilenameFor("@corbits/memory-tools", "0.0.1");
    expect(filename).toBe("corbits-memory-tools-0.0.1.tgz");
    expect(TARBALL_FILENAME_PATTERN.test(filename)).toBe(true);
  });
});

describe("packToolPackageTarball", () => {
  test("registers at least one @corbits tool package", () => {
    expect(CORBITS_TOOL_PACKAGE_DIRS.length).toBeGreaterThan(0);
  });

  for (const packageDir of CORBITS_TOOL_PACKAGE_DIRS) {
    test(`packs ${path.basename(packageDir)} into a self-contained, validating tarball`, async () => {
      const tarball = await packToolPackageTarball(packageDir);

      expect(tarball.filename).toBe(
        tarballFilenameFor(tarball.name, tarball.version),
      );
      expect(TARBALL_FILENAME_PATTERN.test(tarball.filename)).toBe(true);
      expect(tarball.bytes.byteLength).toBeGreaterThan(0);

      const extractDir = await mkdtemp(
        path.join(tmpdir(), "corbits-tools-pack-test-"),
      );
      try {
        await Bun.write(
          path.join(extractDir, "out.tgz"),
          Buffer.from(tarball.bytes),
        );
        await tar.extract({
          cwd: extractDir,
          file: path.join(extractDir, "out.tgz"),
        });

        const pkgJsonPath = path.join(extractDir, "package", "package.json");
        const pkgJson = (await Bun.file(pkgJsonPath).json()) as {
          name: string;
          version: string;
          interchange?: { tools?: string };
        };
        expect(pkgJson.name).toBe(tarball.name);
        expect(pkgJson.version).toBe(tarball.version);
        expect(pkgJson.interchange?.tools).toBe("./tool.mjs");

        // The bundle must be import()-able on its own, with no bare
        // (non-relative) specifiers left unresolved — exactly what the
        // sidecar's tool loader does after extracting the tarball.
        const bundlePath = path.join(extractDir, "package", "tool.mjs");
        const mod = (await import(bundlePath)) as Record<string, unknown>;
        const factories = Object.values(mod).filter(
          (value) =>
            (typeof value === "function" || typeof value === "object") &&
            value !== null &&
            "id" in (value as object),
        );
        expect(factories.length).toBeGreaterThan(0);
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    });
  }

  test(`${CORBITS_TOOLS_REGISTRY} is the registry these packages publish into`, () => {
    // Documents the contract packages.test asserts against — a rename
    // of the registry constant without updating this fixture set would
    // still leave the tests above green, since they never spell the
    // registry name; this is the one place that connects the two.
    expect(CORBITS_TOOLS_REGISTRY).toBe("corbits-tools");
  });
});
