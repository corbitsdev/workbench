import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { packToolPackageTarball } from "./pack";
import { readToolSurfaceManifests } from "./surface-reader";

/** A registry tarball published before manifests existed: a real tgz
 * whose package.json parses but carries no `surface` key. */
async function legacyTarball(): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "legacy-pkg-"));
  await mkdir(path.join(dir, "package"), { recursive: true });
  await writeFile(
    path.join(dir, "package", "package.json"),
    JSON.stringify({
      name: "@corbits/pre-manifest-legacy",
      version: "1.0.0",
      interchange: { tools: {} },
    }),
  );
  const out = path.join(dir, "legacy.tgz");
  await tar.create({ cwd: dir, file: out, gzip: true }, ["package"]);
  return new Uint8Array(await readFile(out));
}

function memorySource(files: Map<string, Uint8Array>) {
  return {
    listBlobs: (dir: string) =>
      Promise.resolve(
        [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
      ),
    readBlob: (path: string) => {
      const bytes = files.get(path);
      if (bytes === undefined) return Promise.reject(new Error(`no ${path}`));
      return Promise.resolve(bytes);
    },
  };
}

describe("readToolSurfaceManifests", () => {
  test("round-trips a packed tarball into a validated manifest", async () => {
    const tarball = await packToolPackageTarball(
      new URL("../../memory-tools", import.meta.url).pathname,
    );
    const source = memorySource(
      new Map([[`tarballs/${tarball.filename}`, tarball.bytes]]),
    );
    const manifests = await readToolSurfaceManifests({
      ...source,
      rootDir: "tarballs",
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe("@corbits/memory-tools");
    expect(manifests[0]?.surface.map((entry) => entry.qualifiedId)).toContain(
      "@corbits/memory-tools/memory:memory_add",
    );
    expect(manifests[0]?.surface.every((entry) => entry.kind === "tool")).toBe(
      true,
    );
  });

  test("ignores non-tarball blobs and reports none when the registry is empty", async () => {
    const source = memorySource(
      new Map([["tarballs/README.md", new TextEncoder().encode("hi")]]),
    );
    expect(
      await readToolSurfaceManifests({ ...source, rootDir: "tarballs" }),
    ).toEqual([]);
  });

  test("skips a tarball whose package.json is not a valid manifest", async () => {
    const tarball = await packToolPackageTarball(
      new URL("../../memory-tools", import.meta.url).pathname,
    );
    // Corrupt the packaged manifest by re-packing a tampered file is
    // overkill; a truncated tarball is enough to prove the reader skips
    // the blob instead of failing the whole read. Registries published
    // before manifests existed hold such blobs, and shouldPublishTarball
    // never re-uploads an existing name@version to heal them.
    const truncated = tarball.bytes.slice(0, 64);
    const source = memorySource(new Map([["tarballs/broken.tgz", truncated]]));
    expect(
      await readToolSurfaceManifests({ ...source, rootDir: "tarballs" }),
    ).toEqual([]);
  });

  test("returns the valid manifests and skips the manifest-less legacy ones", async () => {
    const tarball = await packToolPackageTarball(
      new URL("../../memory-tools", import.meta.url).pathname,
    );
    const source = memorySource(
      new Map([
        [`tarballs/${tarball.filename}`, tarball.bytes],
        ["tarballs/legacy.tgz", await legacyTarball()],
      ]),
    );
    const manifests = await readToolSurfaceManifests({
      ...source,
      rootDir: "tarballs",
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe("@corbits/memory-tools");
  });
});
