// CL-6225: workbench mint is slow because every agent launch re-reads every
// tarball in a tenant's `corbits-tools` package-registry asset and rebuilds
// a full git pack for every asset attachment — see
// `AssetRegistrySource.#buildPackuments` in
// `vendor/intx/tool-packaging/src/resolver.ts` and
// `resolveAssetAttachment` in `vendor/intx/hub-sessions/src/session-service.ts`.
// Both reads are uncached across launches even though the content they read
// is immutable per commit: a blob, a directory listing, and a deploy pack
// are all pure functions of (repoId, commit SHA, path). This module wraps
// the two vendored services the launch path consumes with a SHA-keyed
// cache, so a tenant whose tool registry hasn't changed since the last
// launch pays for one cheap `resolveRef` instead of re-reading and
// re-hashing every tarball, and instead of rebuilding the deploy pack.
//
// Because the cache key always includes the content's commit SHA, no
// write-through invalidation is needed: a write advances the ref to a new
// SHA, which is simply a cache miss the next time the ref is read. Stale
// entries for abandoned SHAs age out of the bounded LRU on their own.
//
// Safety invariant: this wrapper is only sound for a caller that always
// reads with the same fully-trusted principal, because a `createPack` cache
// hit returns pack bytes without re-running the substrate's per-call
// `authorize` gate. The hub's launch path satisfies this today —
// `resolveAssetAttachment` in `session-service.ts` always calls
// `agentRepoStore.repoStore` with its own internal `{ kind: "hub" }`
// principal — but this wrapper must never be wired into the smart-HTTP git
// routes or the asset REST routes, where different requests carry different,
// less-privileged principals.
//
// `assetService.readAssetBlob` / `listAssetBlobs` resolve their ref through
// their own direct `isomorphic-git` call and never surface the SHA they
// landed on, so this module learns it independently via
// `repoStore.resolveRef` before touching the cache. The launch path's only
// `assetService` consumer (`buildAndResolve` in `session-service.ts`) reads
// exclusively from `package-registry` assets, so the `RepoId` this module
// builds for that lookup hardcodes `kind: "package-registry"` — the same
// `{ kind, id }` shape `assetService`'s own `resolveCommitTreeOid` computes
// a directory from, so the two stay pointed at the same on-disk repo.
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import type {
  AssetService,
  ListAssetBlobsParams,
  Principal,
  ReadAssetBlobParams,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const LAUNCH_CACHE_PRINCIPAL: Principal = { kind: "hub" };

type WeighedEntry<V> = { value: V; bytes: number };

/**
 * Bounded LRU keyed by string. A `Map`'s iteration order already tracks
 * insertion order, so recency is tracked by deleting and re-inserting a key
 * on every touch; the oldest (first) key is always the eviction candidate.
 * Eviction runs after every `set` until the cache is back under both the
 * entry-count and byte budgets.
 */
class BoundedCache<V> {
  readonly #entries = new Map<string, WeighedEntry<V>>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxEntries: number, maxBytes: number) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined) this.#bytes -= existing.bytes;
    this.#entries.delete(key);
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    this.#evictOverBudget();
  }

  #evictOverBudget(): void {
    while (this.#isOverBudget() && this.#entries.size > 0) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      if (oldest !== undefined) this.#bytes -= oldest.bytes;
    }
  }

  #isOverBudget(): boolean {
    return this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes;
  }
}

function utf16Bytes(value: string): number {
  return value.length * 2;
}

export type LaunchCaches = {
  assetService: AssetService;
  repoStore: RepoStore;
};

export function createLaunchCaches(deps: {
  assetService: AssetService;
  repoStore: RepoStore;
  maxEntries?: number;
  maxBytes?: number;
}): LaunchCaches {
  const { assetService, repoStore } = deps;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  const blobCache = new BoundedCache<Uint8Array>(maxEntries, maxBytes);
  const listCache = new BoundedCache<string[]>(maxEntries, maxBytes);
  const packCache = new BoundedCache<{
    pack: Uint8Array;
    commitSha: string;
    ref: string;
  }>(maxEntries, maxBytes);

  async function resolvePackageRegistryHeadSha(
    assetId: string,
    ref: string | undefined,
  ): Promise<string | null> {
    const effectiveRef = ref ?? DEFAULT_ASSET_REF;
    const repoId: RepoId = { kind: "package-registry", id: assetId };
    return repoStore.resolveRef(LAUNCH_CACHE_PRINCIPAL, repoId, effectiveRef);
  }

  async function readAssetBlob(
    params: ReadAssetBlobParams,
  ): Promise<Uint8Array> {
    const sha = await resolvePackageRegistryHeadSha(params.assetId, params.ref);
    if (sha === null) return assetService.readAssetBlob(params);
    const key = `${params.assetId}:${sha}:${params.path}`;
    const cached = blobCache.get(key);
    if (cached !== undefined) return cached;
    const blob = await assetService.readAssetBlob(params);
    blobCache.set(key, blob, blob.byteLength);
    return blob;
  }

  async function listAssetBlobs(
    params: ListAssetBlobsParams,
  ): Promise<string[]> {
    const sha = await resolvePackageRegistryHeadSha(params.assetId, params.ref);
    if (sha === null) return assetService.listAssetBlobs(params);
    const key = `${params.assetId}:${sha}:${params.dir}`;
    const cached = listCache.get(key);
    if (cached !== undefined) return cached;
    const list = await assetService.listAssetBlobs(params);
    const bytes = list.reduce((sum, name) => sum + utf16Bytes(name), 0);
    listCache.set(key, list, bytes);
    return list;
  }

  const cachedAssetService: AssetService = {
    createAsset: assetService.createAsset,
    populateAsset: assetService.populateAsset,
    readAssetBlob,
    listAssetBlobs,
  };

  async function createPack(
    principal: Principal,
    repoId: RepoId,
    ref: string,
  ): Promise<{ pack: Uint8Array; commitSha: string; ref: string }> {
    const sha = await repoStore.resolveRef(principal, repoId, ref);
    if (sha === null) return repoStore.createPack(principal, repoId, ref);
    const key = `${repoId.kind}/${repoId.id}:${sha}`;
    const cached = packCache.get(key);
    if (cached !== undefined) return cached;
    const built = await repoStore.createPack(principal, repoId, ref);
    packCache.set(key, built, built.pack.byteLength);
    return built;
  }

  const cachedRepoStore: RepoStore = {
    initRepo: repoStore.initRepo,
    writeTree: repoStore.writeTree,
    writeTreePreservingPrefix: repoStore.writeTreePreservingPrefix,
    writeTreeDelta: repoStore.writeTreeDelta,
    receivePack: repoStore.receivePack,
    createPack,
    commitPackedTip: repoStore.commitPackedTip,
    resolveRef: repoStore.resolveRef,
    listRefs: repoStore.listRefs,
    resolveHead: repoStore.resolveHead,
    getRepoDir: repoStore.getRepoDir,
    openCommittedReads: repoStore.openCommittedReads,
    openCommittedReadsAtCommit: repoStore.openCommittedReadsAtCommit,
    subscribe: repoStore.subscribe,
  };

  return { assetService: cachedAssetService, repoStore: cachedRepoStore };
}
