/** One navigation the palette can replay from the Recents group. `kind`
 * carries enough provenance for the consumer to route the selection back —
 * this module never interprets it. */
export type RecentEntry = {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
};

const MAX_RECENTS = 5;

function recentKey(entry: Pick<RecentEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

/** Moves `entry` to the front of `entries`, de-duplicating by kind+id and
 * capping the list at `max`. Pure — the caller owns persistence. */
export function addRecentEntry(
  entries: readonly RecentEntry[],
  entry: RecentEntry,
  max = MAX_RECENTS,
): readonly RecentEntry[] {
  const withoutEntry = entries.filter(
    (existing) => recentKey(existing) !== recentKey(entry),
  );
  return [entry, ...withoutEntry].slice(0, max);
}

/** Drops the entry matching `kind`+`id`, if present. Pure, the same way
 * `addRecentEntry` is — used to self-heal a Recents list once the entity it
 * points at is confirmed gone (e.g. a workbench that 404s). */
export function removeRecentEntry(
  entries: readonly RecentEntry[],
  entry: Pick<RecentEntry, "kind" | "id">,
): readonly RecentEntry[] {
  return entries.filter((existing) => recentKey(existing) !== recentKey(entry));
}

/** The bare persistence surface `createRecentsStore` needs — `localStorage`
 * satisfies this, and so does any in-memory fake a test hands in. */
export type RecentsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type RecentsStore = {
  readonly load: () => readonly RecentEntry[];
  readonly push: (entry: RecentEntry) => readonly RecentEntry[];
  readonly remove: (
    entry: Pick<RecentEntry, "kind" | "id">,
  ) => readonly RecentEntry[];
};

function isRecentEntry(value: unknown): value is RecentEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    (candidate.subtitle === undefined || typeof candidate.subtitle === "string")
  );
}

/**
 * A small localStorage-backed Recents list, keyed by `storageKey` so each
 * bench keeps its own history. Malformed or missing stored data is treated
 * as an empty list rather than thrown — a corrupt entry never breaks the
 * palette.
 */
export function createRecentsStore(
  storage: RecentsStorage,
  storageKey: string,
  max = MAX_RECENTS,
): RecentsStore {
  function load(): readonly RecentEntry[] {
    const raw = storage.getItem(storageKey);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentEntry).slice(0, max);
  }

  function push(entry: RecentEntry): readonly RecentEntry[] {
    const next = addRecentEntry(load(), entry, max);
    try {
      storage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // A full or disabled store (private browsing, quota) loses
      // persistence, not function — the caller still gets the updated list
      // for this render.
    }
    return next;
  }

  function remove(
    entry: Pick<RecentEntry, "kind" | "id">,
  ): readonly RecentEntry[] {
    const next = removeRecentEntry(load(), entry);
    try {
      storage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // As above — loses persistence, not function.
    }
    return next;
  }

  return { load, push, remove };
}
