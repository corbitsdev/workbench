// CL-6225: proves the launch-path read cache serves repeated reads of the
// same commit from memory (inner service called once), still calls through
// on a genuinely different commit, evicts under its byte budget, and leaves
// every other AssetService/RepoStore method wired straight through.
import { describe, expect, test } from "bun:test";
import type {
  Asset,
  AssetService,
  ListAssetBlobsParams,
  Principal,
  ReadAssetBlobParams,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions";
import { createLaunchCaches } from "./launch-caches";

const ASSET_ID = "asset_pkgreg1";
const HEAD_REF = "refs/heads/main";

function countingAssetService(heads: Map<string, string | null>): {
  assetService: AssetService;
  readCalls: ReadAssetBlobParams[];
  listCalls: ListAssetBlobsParams[];
} {
  const readCalls: ReadAssetBlobParams[] = [];
  const listCalls: ListAssetBlobsParams[] = [];
  const assetService: AssetService = {
    createAsset: (): Promise<Asset> => {
      throw new Error("not exercised in these tests");
    },
    populateAsset: () => {
      throw new Error("not exercised in these tests");
    },
    readAssetBlob: (params) => {
      readCalls.push(params);
      const sha = heads.get(params.ref ?? HEAD_REF) ?? "missing";
      return Promise.resolve(new TextEncoder().encode(`${params.path}@${sha}`));
    },
    listAssetBlobs: (params) => {
      listCalls.push(params);
      return Promise.resolve(["tarballs/a.tgz", "tarballs/b.tgz"]);
    },
  };
  return { assetService, readCalls, listCalls };
}

function countingRepoStore(heads: Map<string, string | null>): {
  repoStore: RepoStore;
  resolveRefCalls: number;
  createPackCalls: { repoId: RepoId; ref: string }[];
} {
  const createPackCalls: { repoId: RepoId; ref: string }[] = [];
  let resolveRefCalls = 0;
  const repoStore: RepoStore = {
    initRepo: () => Promise.resolve(),
    writeTree: () => {
      throw new Error("not exercised in these tests");
    },
    writeTreePreservingPrefix: () => {
      throw new Error("not exercised in these tests");
    },
    writeTreeDelta: () => {
      throw new Error("not exercised in these tests");
    },
    receivePack: () => {
      throw new Error("not exercised in these tests");
    },
    createPack: (_principal: Principal, repoId: RepoId, ref: string) => {
      createPackCalls.push({ repoId, ref });
      const sha = heads.get(ref) ?? "missing";
      const pack = new TextEncoder().encode(`pack@${sha}`);
      return Promise.resolve({ pack, commitSha: sha, ref });
    },
    commitPackedTip: () => undefined,
    resolveRef: (_principal: Principal, _repoId: RepoId, ref: string) => {
      resolveRefCalls += 1;
      return Promise.resolve(heads.get(ref) ?? null);
    },
    listRefs: () => Promise.resolve([]),
    resolveHead: () => Promise.resolve(null),
    getRepoDir: (repoId: RepoId) => `/data/${repoId.kind}/${repoId.id}`,
    openCommittedReads: () => Promise.resolve(null),
    openCommittedReadsAtCommit: () => Promise.resolve(null),
    subscribe: () => {
      throw new Error("not exercised in these tests");
    },
  };
  return { repoStore, resolveRefCalls, createPackCalls };
}

describe("createLaunchCaches: assetService reads", () => {
  test("serves a repeated blob read at the same head SHA from cache", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
    });

    const first = await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: "tarballs/a.tgz",
    });
    const second = await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: "tarballs/a.tgz",
    });

    expect(inner.readCalls.length).toBe(1);
    expect(second).toEqual(first);
  });

  test("misses the cache when the head SHA changes", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
    });

    await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: "tarballs/a.tgz",
    });
    heads.set(HEAD_REF, "sha-2");
    await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: "tarballs/a.tgz",
    });

    expect(inner.readCalls.length).toBe(2);
  });

  test("caches listAssetBlobs the same way", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
    });

    await caches.assetService.listAssetBlobs({
      assetId: ASSET_ID,
      dir: "tarballs",
    });
    await caches.assetService.listAssetBlobs({
      assetId: ASSET_ID,
      dir: "tarballs",
    });

    expect(inner.listCalls.length).toBe(1);
  });

  test("lists an empty catalog when the package-registry has no resolvable main", async () => {
    const heads = new Map<string, string | null>();
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
    });

    const listed = await caches.assetService.listAssetBlobs({
      assetId: ASSET_ID,
      dir: "tarballs",
    });

    expect(listed).toEqual([]);
    expect(inner.listCalls.length).toBe(0);
  });

  test("delegates createAsset and populateAsset untouched", () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
    });

    expect(caches.assetService.createAsset).toBe(
      inner.assetService.createAsset,
    );
    expect(caches.assetService.populateAsset).toBe(
      inner.assetService.populateAsset,
    );
  });
});

describe("createLaunchCaches: repoStore packs", () => {
  const repoId: RepoId = { kind: "package-registry", id: ASSET_ID };
  const principal: Principal = { kind: "hub" };

  test("serves a repeated createPack at the same commit from cache", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const { repoStore, createPackCalls } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: countingAssetService(heads).assetService,
      repoStore,
    });

    const first = await caches.repoStore.createPack(
      principal,
      repoId,
      HEAD_REF,
    );
    const second = await caches.repoStore.createPack(
      principal,
      repoId,
      HEAD_REF,
    );

    expect(createPackCalls.length).toBe(1);
    expect(second).toEqual(first);
  });

  test("rebuilds the pack when the ref moves to a new commit", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const { repoStore, createPackCalls } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: countingAssetService(heads).assetService,
      repoStore,
    });

    await caches.repoStore.createPack(principal, repoId, HEAD_REF);
    heads.set(HEAD_REF, "sha-2");
    await caches.repoStore.createPack(principal, repoId, HEAD_REF);

    expect(createPackCalls.length).toBe(2);
  });

  test("delegates every other RepoStore method untouched", () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: countingAssetService(heads).assetService,
      repoStore,
    });

    expect(caches.repoStore.initRepo).toBe(repoStore.initRepo);
    expect(caches.repoStore.writeTree).toBe(repoStore.writeTree);
    expect(caches.repoStore.writeTreePreservingPrefix).toBe(
      repoStore.writeTreePreservingPrefix,
    );
    expect(caches.repoStore.writeTreeDelta).toBe(repoStore.writeTreeDelta);
    expect(caches.repoStore.receivePack).toBe(repoStore.receivePack);
    expect(caches.repoStore.commitPackedTip).toBe(repoStore.commitPackedTip);
    expect(caches.repoStore.resolveRef).toBe(repoStore.resolveRef);
    expect(caches.repoStore.listRefs).toBe(repoStore.listRefs);
    expect(caches.repoStore.resolveHead).toBe(repoStore.resolveHead);
    expect(caches.repoStore.getRepoDir).toBe(repoStore.getRepoDir);
    expect(caches.repoStore.openCommittedReads).toBe(
      repoStore.openCommittedReads,
    );
    expect(caches.repoStore.openCommittedReadsAtCommit).toBe(
      repoStore.openCommittedReadsAtCommit,
    );
    expect(caches.repoStore.subscribe).toBe(repoStore.subscribe);
  });
});

describe("createLaunchCaches: bounded LRU eviction", () => {
  test("evicts the least-recently-used blob once the byte budget is exceeded", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
      maxBytes: 32,
      maxEntries: 64,
    });

    const bigPath = "tarballs/" + "a".repeat(20) + ".tgz";
    const otherPath = "tarballs/" + "b".repeat(20) + ".tgz";
    await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: bigPath,
    });
    await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: otherPath,
    });
    // The budget is too small to hold both; the first entry should have
    // been evicted, so re-reading it calls through again.
    await caches.assetService.readAssetBlob({
      assetId: ASSET_ID,
      path: bigPath,
    });

    expect(inner.readCalls.length).toBe(3);
  });

  test("evicts the least-recently-used entry once the entry-count budget is exceeded", async () => {
    const heads = new Map([[HEAD_REF, "sha-1"]]);
    const inner = countingAssetService(heads);
    const { repoStore } = countingRepoStore(heads);
    const caches = createLaunchCaches({
      assetService: inner.assetService,
      repoStore,
      maxEntries: 2,
      maxBytes: 1024 * 1024,
    });

    await caches.assetService.readAssetBlob({ assetId: ASSET_ID, path: "a" });
    await caches.assetService.readAssetBlob({ assetId: ASSET_ID, path: "b" });
    await caches.assetService.readAssetBlob({ assetId: ASSET_ID, path: "c" });
    // "a" should have been evicted to make room for "c".
    await caches.assetService.readAssetBlob({ assetId: ASSET_ID, path: "a" });

    expect(inner.readCalls.length).toBe(4);
  });
});
