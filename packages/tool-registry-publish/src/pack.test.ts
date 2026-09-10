import { describe, expect, test } from "bun:test";
import * as tar from "tar";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type } from "arktype";
import { CORBITS_TOOL_PACKAGE_DIRS, CORBITS_TOOLS_REGISTRY } from "./registry";
import { packToolPackageTarball, tarballFilenameFor } from "./pack";
import { ToolSurfaceManifest } from "./manifest";
import { describeCorbitsToolPackages } from "./describe";

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
          surface?: unknown;
        };
        expect(pkgJson.name).toBe(tarball.name);
        expect(pkgJson.version).toBe(tarball.version);
        expect(pkgJson.interchange?.tools).toBe("./tool.mjs");

        // The synthesized package.json must carry a valid tool-surface
        // manifest — the hub reads this, not the source tree, for grants.
        const surface = ToolSurfaceManifest(pkgJson);
        expect(surface).not.toBeInstanceOf(type.errors);

        // Loader parity: the manifest's qualifiedIds must equal exactly
        // what the sidecar's tool loader sees when it import()s the
        // packed bundle — `<bundle.id>:<definition.name>` per definition
        // (see `@intx/tool-packaging/src/loader.ts`'s
        // `applyNamespacePrefix`).
        const bundlePath = path.join(extractDir, "package", "tool.mjs");
        const mod = (await import(bundlePath)) as Record<string, unknown>;
        const factories = Object.values(mod).filter(
          (value) =>
            typeof value === "function" &&
            typeof (value as { id?: unknown }).id === "string" &&
            Array.isArray((value as { definitions?: unknown }).definitions),
        );
        expect(factories.length).toBeGreaterThan(0);
        if (!(surface instanceof type.errors)) {
          const loaderIds = factories.flatMap((factory) =>
            (
              factory as {
                id: string;
                definitions: { name: string }[];
              }
            ).definitions.map(
              (definition) =>
                `${(factory as { id: string }).id}:${definition.name}`,
            ),
          );
          expect([...surface.surface.map((e) => e.qualifiedId)].sort()).toEqual(
            [...loaderIds].sort(),
          );
        }

        if (tarball.name === "@corbits/catalog-tools") {
          // Both bundles this package exports (the read-only
          // `catalogTools` and CL-7468's write-capable
          // `catalogOfferingTools`) must resolve by id from the packed
          // tarball the sidecar actually loads, not just from the
          // workspace source tree — a bundle dropped from `./index.ts`'s
          // re-exports would still leave `factories.length` above 0.
          const ids = factories.map(
            (factory) => (factory as { id: string }).id,
          );
          expect(ids).toContain("@corbits/catalog-tools/catalog");
          expect(ids).toContain("@corbits/catalog-tools/off");
        }
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

  // Parity gate for the describe.ts → packed-manifest migration: the
  // surface packed into each tarball must exactly match the enumeration
  // the (soon-deleted) source-importing describer produced, including
  // approval marks and the sidecar loader's namespacing — e.g.
  // `@corbits/memory-tools/memory:memory_add`.
  test("packed surface matches describeCorbitsToolPackages exactly", async () => {
    const descriptions = await describeCorbitsToolPackages();
    expect(descriptions.length).toBe(CORBITS_TOOL_PACKAGE_DIRS.length);
    for (const description of descriptions) {
      const tarball = await packToolPackageTarball(
        CORBITS_TOOL_PACKAGE_DIRS.find(
          (dir) => path.basename(dir) === description.name.split("/")[1],
        ) ?? "",
      );
      const extractDir = await mkdtemp(
        path.join(tmpdir(), "corbits-tools-surface-parity-"),
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
        const pkgJson = (await Bun.file(
          path.join(extractDir, "package", "package.json"),
        ).json()) as unknown;
        const manifest = ToolSurfaceManifest(pkgJson);
        expect(manifest).not.toBeInstanceOf(type.errors);
        if (!(manifest instanceof type.errors)) {
          expect(manifest.name).toBe(description.name);
          expect(manifest.version).toBe(description.version);
          expect(manifest.surface).toEqual(
            description.tools.map((tool) => ({
              qualifiedId: tool.qualifiedId,
              kind: "tool",
              ...(tool.approval !== undefined
                ? { approval: tool.approval }
                : {}),
            })),
          );
        }
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    }
  });
});
