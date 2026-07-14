const STORAGE_KEY = "cw-myra-reasoning-expanded";

export type ReasoningExpandedMap = Record<string, boolean>;

function readMap(storage: Storage): ReasoningExpandedMap {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: ReasoningExpandedMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && typeof value === "boolean") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(storage: Storage, map: ReasoningExpandedMap): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable
  }
}

/** Read whether reasoning for a message key is expanded (default collapsed). */
export function readReasoningExpanded(
  messageKey: string,
  storage: Storage = localStorage,
): boolean {
  return readMap(storage)[messageKey] === true;
}

/** Persist per-message reasoning expand/collapse (survives reload). */
export function writeReasoningExpanded(
  messageKey: string,
  expanded: boolean,
  storage: Storage = localStorage,
): void {
  const map = readMap(storage);
  if (expanded) {
    map[messageKey] = true;
  } else {
    delete map[messageKey];
  }
  writeMap(storage, map);
}

/** Remove a message key (e.g. after migrating streaming → settled id). */
export function clearReasoningExpanded(
  messageKey: string,
  storage: Storage = localStorage,
): void {
  const map = readMap(storage);
  if (!(messageKey in map)) return;
  delete map[messageKey];
  writeMap(storage, map);
}