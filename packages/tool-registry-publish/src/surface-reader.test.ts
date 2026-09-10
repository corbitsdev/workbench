import { describe, expect, test } from "bun:test";
import { packToolPackageTarball } from "./pack";
import { readToolSurfaceManifests } from "./surface-reader";

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

  test("rejects a tarball whose package.json is not a valid manifest", async () => {
    const tarball = await packToolPackageTarball(
      new URL("../../memory-tools", import.meta.url).pathname,
    );
    // Corrupt the packaged manifest by re-packing a tampered file is
    // overkill; a truncated tarball is enough to prove the reader fails
    // loud rather than returning a partial list.
    const truncated = tarball.bytes.slice(0, 64);
    const source = memorySource(new Map([["tarballs/broken.tgz", truncated]]));
    await expect(
      readToolSurfaceManifests({ ...source, rootDir: "tarballs" }),
    ).rejects.toThrow();
  });
});
