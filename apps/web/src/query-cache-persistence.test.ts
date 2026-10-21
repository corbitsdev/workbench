// Unit tests for IndexedDB-backed TanStack Query cache persistence (`query-cache-persistence.ts`).
// Uses a lightweight fake IDBFactory so persistence, hydration, expiry, and
// clear flows run deterministically without a browser DOM.
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  attachQueryCachePersistence,
  clearPersistedQueryCache,
  hydrateQueryClientFromIndexedDB,
  type PersistedQueryEntry,
} from "./query-cache-persistence";
import { tenantKeys } from "./query-client";

function createFakeIdb(): {
  readonly factory: IDBFactory;
  readonly rows: Map<string, PersistedQueryEntry>;
} {
  const rows = new Map<string, PersistedQueryEntry>();

  function makeRequest<T>(compute: () => T): IDBRequest<T> {
    const req = {
      result: undefined as unknown as T,
      error: null,
      onsuccess: null as ((this: IDBRequest<T>, ev: Event) => unknown) | null,
      onerror: null as ((this: IDBRequest<T>, ev: Event) => unknown) | null,
    } as unknown as IDBRequest<T>;
    queueMicrotask(() => {
      (req as { result: T }).result = compute();
      req.onsuccess?.call(req, new Event("success"));
    });
    return req;
  }

  const store = {
    put(value: PersistedQueryEntry) {
      return makeRequest(() => {
        rows.set(value.queryHash, value);
        return value.queryHash;
      });
    },
    delete(key: string) {
      return makeRequest(() => {
        rows.delete(key);
      });
    },
    clear() {
      return makeRequest(() => {
        rows.clear();
      });
    },
    getAll() {
      return makeRequest(() => [...rows.values()]);
    },
  };

  const db = {
    objectStoreNames: {
      contains: () => true,
    },
    createObjectStore: () => store,
    transaction: () => {
      const tx = {
        objectStore: () => store,
        oncomplete: null as ((this: IDBTransaction, ev: Event) => unknown) | null,
        onerror: null as ((this: IDBTransaction, ev: Event) => unknown) | null,
        error: null,
      } as unknown as IDBTransaction;
      queueMicrotask(() => {
        tx.oncomplete?.call(tx, new Event("complete"));
      });
      return tx;
    },
    close: () => undefined,
  };

  const factory = {
    open() {
      const req = {
        result: db,
        error: null,
        onupgradeneeded: null as
          | ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown)
          | null,
        onsuccess: null as ((this: IDBOpenDBRequest, ev: Event) => unknown) | null,
        onerror: null as ((this: IDBOpenDBRequest, ev: Event) => unknown) | null,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        req.onsuccess?.call(req, new Event("success"));
      });
      return req;
    },
  } as unknown as IDBFactory;

  return { factory, rows };
}

describe("query-cache-persistence", () => {
  test("persists successful query data and hydrates it into a fresh QueryClient", async () => {
    const { factory, rows } = createFakeIdb();
    const writerClient = new QueryClient();
    const detach = attachQueryCachePersistence(writerClient, {
      idbFactory: factory,
      debounceMs: 5,
    });

    const benchAKey = tenantKeys.skills("bench-a");
    const benchBKey = tenantKeys.skills("bench-b");
    writerClient.setQueryData(benchAKey, [{ assetId: "s1", name: "alpha" }]);
    writerClient.setQueryData(benchBKey, [{ assetId: "s2", name: "beta" }]);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rows.size).toBe(2);

    const readerClient = new QueryClient();
    await hydrateQueryClientFromIndexedDB(readerClient, { idbFactory: factory });

    expect(readerClient.getQueryData<unknown>(benchAKey)).toEqual([
      { assetId: "s1", name: "alpha" },
    ]);
    expect(readerClient.getQueryData<unknown>(benchBKey)).toEqual([
      { assetId: "s2", name: "beta" },
    ]);

    detach();
  });

  test("skips expired entries during hydration and does not overwrite fresher in-memory data", async () => {
    const { factory, rows } = createFakeIdb();
    const key = tenantKeys.routines("bench-a");
    const expiredKey = tenantKeys.routines("bench-expired");
    const now = Date.now();

    rows.set(JSON.stringify(key), {
      queryHash: JSON.stringify(key),
      queryKey: key,
      data: ["older-from-idb"],
      dataUpdatedAt: now - 10_000,
    });
    rows.set(JSON.stringify(expiredKey), {
      queryHash: JSON.stringify(expiredKey),
      queryKey: expiredKey,
      data: ["stale-expired"],
      dataUpdatedAt: now - 48 * 60 * 60 * 1000,
    });

    const client = new QueryClient();
    client.setQueryData(key, ["newer-in-memory"], { updatedAt: now });

    await hydrateQueryClientFromIndexedDB(client, {
      idbFactory: factory,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(client.getQueryData<unknown>(key)).toEqual(["newer-in-memory"]);
    expect(client.getQueryData<unknown>(expiredKey)).toBeUndefined();
  });

  test("clearPersistedQueryCache wipes stored entries", async () => {
    const { factory, rows } = createFakeIdb();
    const key = tenantKeys.assets("bench-a");
    rows.set(JSON.stringify(key), {
      queryHash: JSON.stringify(key),
      queryKey: key,
      data: [{ id: "asset-1" }],
      dataUpdatedAt: Date.now(),
    });

    await clearPersistedQueryCache(factory);
    expect(rows.size).toBe(0);
  });

  test("gracefully no-ops when indexedDB is unavailable", async () => {
    const client = new QueryClient();
    const detach = attachQueryCachePersistence(client, { idbFactory: undefined });
    client.setQueryData(tenantKeys.skills("bench-a"), []);
    await expect(
      hydrateQueryClientFromIndexedDB(client, { idbFactory: undefined }),
    ).resolves.toBeUndefined();
    await expect(clearPersistedQueryCache(undefined)).resolves.toBeUndefined();
    detach();
  });
});
