// Hydrates cached query entries on boot as stale-while-revalidate so active
// queries render cached data immediately while still revalidating against the
// hub on a page reload, and flushes successful snapshots on a microtask.

import { reportError } from "@corbits/error-sink";
import type { QueryClient } from "@tanstack/react-query";
import { type } from "arktype";

const DB_NAME = "workbench-query-cache-v1";
const DB_VERSION = 1;
const STORE_NAME = "queries";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PersistedQueryEntrySchema = type({
  queryHash: "string",
  queryKey: "unknown[]",
  data: "unknown",
  dataUpdatedAt: "number",
});

export type PersistedQueryEntry = {
  readonly queryHash: string;
  readonly queryKey: readonly unknown[];
  readonly data: unknown;
  readonly dataUpdatedAt: number;
};

function resolveIdbFactory(explicit?: IDBFactory | undefined): IDBFactory | undefined {
  if (arguments.length > 0) return explicit;
  return typeof indexedDB !== "undefined" ? indexedDB : undefined;
}

function openCacheDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "queryHash" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB query cache"));
  });
}

function runStoreRequest<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openCacheDb(factory).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const req = work(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB query cache request failed"));
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB query cache transaction failed"));
        };
      }),
  );
}

// Hydrated entries get `updatedAt: 0` + `invalidateQueries` so TanStack Query's
// 30s `staleTime` never suppresses a fresh fetch on reload, and any query that
// already started fetching before IndexedDB opened is left untouched.
export async function hydrateQueryClientFromIndexedDB(
  queryClient: QueryClient,
  options?: {
    readonly idbFactory?: IDBFactory | undefined;
    readonly maxAgeMs?: number;
  },
): Promise<void> {
  const factory =
    options !== undefined && "idbFactory" in options ? options.idbFactory : resolveIdbFactory();
  if (factory === undefined) return;

  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minUpdatedAt = Date.now() - maxAgeMs;

  try {
    const rawEntries = await runStoreRequest<unknown[]>(factory, "readonly", (store) =>
      store.getAll(),
    );
    const hydratedKeys: (readonly unknown[])[] = [];
    for (const raw of rawEntries) {
      const entry = PersistedQueryEntrySchema(raw);
      if (entry instanceof type.errors) continue;
      if (entry.dataUpdatedAt < minUpdatedAt) continue;

      const existing = queryClient.getQueryState(entry.queryKey);
      if (
        existing !== undefined &&
        (existing.data !== undefined || existing.fetchStatus === "fetching")
      ) {
        continue;
      }
      queryClient.setQueryData(entry.queryKey, entry.data, {
        updatedAt: 0,
      });
      hydratedKeys.push(entry.queryKey);
    }
    for (const queryKey of hydratedKeys) {
      void queryClient.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: "active",
      });
    }
  } catch (cause) {
    reportError(cause, { operation: "queryCachePersistence.hydrate" });
  }
}

export function attachQueryCachePersistence(
  queryClient: QueryClient,
  options?: {
    readonly idbFactory?: IDBFactory | undefined;
    readonly debounceMs?: number;
  },
): () => void {
  const factory =
    options !== undefined && "idbFactory" in options ? options.idbFactory : resolveIdbFactory();
  if (factory === undefined) return () => undefined;

  const debounceMs = options?.debounceMs ?? 0;
  const pendingWrites = new Map<string, PersistedQueryEntry>();
  const pendingDeletes = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let microtaskScheduled = false;

  const flush = () => {
    timer = null;
    microtaskScheduled = false;
    const toWrite = [...pendingWrites.values()];
    const toDelete = [...pendingDeletes];
    pendingWrites.clear();
    pendingDeletes.clear();
    if (toWrite.length === 0 && toDelete.length === 0) return;

    void openCacheDb(factory)
      .then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            for (const hash of toDelete) {
              store.delete(hash);
            }
            for (const entry of toWrite) {
              store.put(entry);
            }
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error ?? new Error("IndexedDB query cache flush failed"));
            };
          }),
      )
      .catch((cause: unknown) => {
        reportError(cause, { operation: "queryCachePersistence.flush" });
      });
  };

  const scheduleFlush = () => {
    if (debounceMs <= 0) {
      if (microtaskScheduled) return;
      microtaskScheduled = true;
      queueMicrotask(flush);
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(flush, debounceMs);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const query = event.query;
    if (event.type === "removed") {
      pendingWrites.delete(query.queryHash);
      pendingDeletes.add(query.queryHash);
      scheduleFlush();
      return;
    }
    if (event.type === "updated" || event.type === "added") {
      if (query.state.isInvalidated) {
        pendingWrites.delete(query.queryHash);
        // Only evict when live data (`dataUpdatedAt > 0`) was invalidated, not
        // when hydration itself seeded `updatedAt: 0`.
        if (query.state.dataUpdatedAt > 0) {
          pendingDeletes.add(query.queryHash);
          scheduleFlush();
        }
        return;
      }
      if (
        query.state.status === "success" &&
        query.state.data !== undefined &&
        query.state.dataUpdatedAt > 0
      ) {
        pendingDeletes.delete(query.queryHash);
        pendingWrites.set(query.queryHash, {
          queryHash: query.queryHash,
          queryKey: [...query.queryKey],
          data: query.state.data,
          dataUpdatedAt: query.state.dataUpdatedAt,
        });
        scheduleFlush();
      }
    }
  });

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    microtaskScheduled = false;
    unsubscribe();
  };
}

export async function clearPersistedQueryCache(idbFactory?: IDBFactory | undefined): Promise<void> {
  const factory = arguments.length > 0 ? idbFactory : resolveIdbFactory();
  if (factory === undefined) return;
  try {
    await runStoreRequest(factory, "readwrite", (store) => store.clear());
  } catch (cause) {
    reportError(cause, { operation: "queryCachePersistence.clear" });
  }
}
