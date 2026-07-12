import { describe, it, expect, mock } from "bun:test";
import {
  createMemoizingImportModule,
  createMemoizingManifestLoad,
  computeManifestHash,
} from "./agent-tools";
import type { LoadedToolPackage } from "@intx/tool-packaging";
import type { ToolPackageManifest } from "@intx/types/tool-packages";

function fakeManifest(
  entries: { name: string; version: string; integrity: string }[],
): typeof ToolPackageManifest.infer {
  return {
    entries: entries.map((e) => ({
      name: e.name,
      version: e.version,
      integrity: e.integrity,
      source: { kind: "asset", assetId: `${e.name}-asset` },
    })),
    topLevel: entries.map((e) => ({ name: e.name, version: e.version })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, loose manifest shape
  } as any;
}

function fakePackage(id: string): LoadedToolPackage {
  return {
    name: id,
    version: "1.0.0",
    factories: [
      Object.assign(() => ({ definitions: [], run: async () => ({}) }), {
        id,
        requires: [] as string[],
      }),
    ] as unknown as LoadedToolPackage["factories"],
    plugins: [],
    directors: [],
  };
}

const fileUrl = (path: string, integrity?: string): string => {
  const base = `file:///${path}`;
  if (integrity === undefined) return base;
  return `${base}?integrity=${encodeURIComponent(integrity)}`;
};

describe("createMemoizingImportModule", () => {
  it("imports once for URLs that differ only in path but share an integrity", async () => {
    const module = { tool: "shared" };
    const inner = mock(async () => module);
    const importModule = createMemoizingImportModule(inner);

    const a = await importModule(fileUrl("agent-a/pkg/index.js", "sha512-abc"));
    const b = await importModule(fileUrl("agent-b/pkg/index.js", "sha512-abc"));

    expect(inner).toHaveBeenCalledTimes(1);
    expect(a).toBe(module);
    expect(b).toBe(module);
    expect(b).toBe(a);
  });

  it("imports separately when integrity values differ", async () => {
    const inner = mock(async (url: string) => ({ url }));
    const importModule = createMemoizingImportModule(inner);

    const a = await importModule(fileUrl("agent-a/pkg/index.js", "sha512-abc"));
    const b = await importModule(fileUrl("agent-a/pkg/index.js", "sha512-xyz"));

    expect(inner).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it("does not memoize a URL with no integrity param", async () => {
    const inner = mock(async (url: string) => ({ url }));
    const importModule = createMemoizingImportModule(inner);

    const url = fileUrl("agent-a/pkg/index.js");
    const a = await importModule(url);
    const b = await importModule(url);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it("dedups concurrent first-callers onto a single underlying import", async () => {
    let resolveImport: (value: { tool: string }) => void = () => {};
    const module = { tool: "shared" };
    const inner = mock(
      () =>
        new Promise<{ tool: string }>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const importModule = createMemoizingImportModule(inner);

    const first = importModule(fileUrl("agent-a/pkg/index.js", "sha512-abc"));
    const second = importModule(fileUrl("agent-b/pkg/index.js", "sha512-abc"));

    expect(inner).toHaveBeenCalledTimes(1);

    resolveImport(module);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(module);
    expect(b).toBe(module);
  });
});

describe("computeManifestHash", () => {
  it("hashes identically regardless of entry order", () => {
    const a = fakeManifest([
      { name: "pkg-a", version: "1.0.0", integrity: "sha512-aaa" },
      { name: "pkg-b", version: "2.0.0", integrity: "sha512-bbb" },
    ]);
    const b = fakeManifest([
      { name: "pkg-b", version: "2.0.0", integrity: "sha512-bbb" },
      { name: "pkg-a", version: "1.0.0", integrity: "sha512-aaa" },
    ]);
    expect(computeManifestHash(a)).toBe(computeManifestHash(b));
  });

  it("hashes differently when a tarball is republished under a new integrity", () => {
    const original = fakeManifest([
      { name: "pkg-a", version: "1.0.0", integrity: "sha512-aaa" },
    ]);
    const republished = fakeManifest([
      { name: "pkg-a", version: "1.0.0", integrity: "sha512-zzz" },
    ]);
    expect(computeManifestHash(original)).not.toBe(
      computeManifestHash(republished),
    );
  });
});

describe("createMemoizingManifestLoad", () => {
  it("loads once for two instances sharing the same manifest hash", async () => {
    const packages = [fakePackage("pkg-a")];
    const loadFn = mock(async () => packages);
    const cache = createMemoizingManifestLoad();

    const first = await cache.load("hash-1", loadFn);
    const second = await cache.load("hash-1", loadFn);

    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(first).toBe(packages);
    expect(second).toBe(packages);
  });

  it("loads separately when the manifest hash changes (republished tarball)", async () => {
    const cache = createMemoizingManifestLoad();
    const loadA = mock(async () => [fakePackage("pkg-a")]);
    const loadB = mock(async () => [fakePackage("pkg-a-v2")]);

    const a = await cache.load("hash-1", loadA);
    const b = await cache.load("hash-2", loadB);

    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
    expect(a).not.toBe(b);
  });

  it("dedups concurrent first-callers onto a single underlying load", async () => {
    let resolveLoad: (value: LoadedToolPackage[]) => void = () => {};
    const packages = [fakePackage("pkg-a")];
    const loadFn = mock(
      () =>
        new Promise<LoadedToolPackage[]>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const cache = createMemoizingManifestLoad();

    const first = cache.load("hash-1", loadFn);
    const second = cache.load("hash-1", loadFn);

    expect(loadFn).toHaveBeenCalledTimes(1);
    resolveLoad(packages);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(packages);
    expect(b).toBe(packages);
  });

  it("does not cache a rejected load, so a transient failure is retried", async () => {
    const cache = createMemoizingManifestLoad();
    const failure = new Error("transient tarball fetch failure");
    const recovered = [fakePackage("pkg-a")];
    let attempt = 0;
    const loadFn = mock(async () => {
      attempt += 1;
      if (attempt === 1) throw failure;
      return recovered;
    });

    await expect(cache.load("hash-1", loadFn)).rejects.toThrow(failure);
    // Allow the `.catch` cache-eviction microtask to settle before retrying.
    await Promise.resolve();
    const retried = await cache.load("hash-1", loadFn);

    expect(loadFn).toHaveBeenCalledTimes(2);
    expect(retried).toBe(recovered);
  });

  it("evicts the least-recently-used hash once the bound is exceeded", async () => {
    const cache = createMemoizingManifestLoad(2);
    const loadA = mock(async () => [fakePackage("pkg-a")]);
    const loadB = mock(async () => [fakePackage("pkg-b")]);
    const loadC = mock(async () => [fakePackage("pkg-c")]);

    await cache.load("hash-a", loadA);
    await cache.load("hash-b", loadB);
    await cache.load("hash-c", loadC);

    expect(cache.size()).toBe(2);
    // hash-a was the least-recently-used at insertion of hash-c; a reload
    // must re-run the loader rather than returning a stale cached slot.
    await cache.load("hash-a", loadA);
    expect(loadA).toHaveBeenCalledTimes(2);
  });

  it("prune drops cache entries whose hash is absent from the active set", async () => {
    const cache = createMemoizingManifestLoad();
    const loadA = mock(async () => [fakePackage("pkg-a")]);
    await cache.load("hash-a", loadA);
    expect(cache.size()).toBe(1);

    cache.prune(new Set());
    expect(cache.size()).toBe(0);

    await cache.load("hash-a", loadA);
    expect(loadA).toHaveBeenCalledTimes(2);
  });

  it("two instances sharing a cache hit construct independent env-scoped bundles", async () => {
    // The cache stores the factory FUNCTION once; each "instance" (two
    // agent launches reusing the same manifest hash) calls that shared
    // factory with its own env, mirroring what default-harness.ts does
    // outside this cache. A leak would show up as instance B's bundle
    // reflecting instance A's env instead of its own.
    const factory = Object.assign(
      (env: { apiKey: string }) => ({ apiKeyUsed: env.apiKey }),
      { id: "pkg-a", requires: [] as string[] },
    );
    const pkg: LoadedToolPackage = {
      name: "pkg-a",
      version: "1.0.0",
      factories: [factory] as unknown as LoadedToolPackage["factories"],
      plugins: [],
      directors: [],
    };
    const cache = createMemoizingManifestLoad();
    const loadFn = mock(async () => [pkg]);

    const loadedForInstanceA = await cache.load("hash-1", loadFn);
    const loadedForInstanceB = await cache.load("hash-1", loadFn);

    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(loadedForInstanceA).toBe(loadedForInstanceB);

    const sharedFactory = loadedForInstanceA[0]?.factories[0] as unknown as (env: {
      apiKey: string;
    }) => { apiKeyUsed: string };
    const bundleA = sharedFactory({ apiKey: "instance-a-key" });
    const bundleB = sharedFactory({ apiKey: "instance-b-key" });

    expect(bundleA.apiKeyUsed).toBe("instance-a-key");
    expect(bundleB.apiKeyUsed).toBe("instance-b-key");
    expect(bundleA.apiKeyUsed).not.toBe(bundleB.apiKeyUsed);
  });
});
