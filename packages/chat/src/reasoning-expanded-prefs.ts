import { isMyraHistoryAged } from "./aged-history";

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

/**
 * Display-time expand state: persisted prefs apply only while the turn is still
 * fresh. Aged turns (see {@link isMyraHistoryAged}) auto-collapse on reload even
 * when localStorage still records an expand choice; the user can expand again in
 * session via the reasoning disclosure's expand toggle.
 */
export function readReasoningExpandedForDisplay(
  messageKey: string,
  createdAt: string | undefined,
  storage: Storage = localStorage,
  nowMs: number = Date.now(),
): boolean {
  if (!readReasoningExpanded(messageKey, storage)) return false;
  if (createdAt !== undefined && isMyraHistoryAged(createdAt, nowMs)) {
    return false;
  }
  return true;
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

/** Prefs key for an agent bubble (matches AgentTurn `feedbackId ?? id`). */
export function reasoningExpandedMessageKey(message: {
  id: string;
  feedbackId?: string;
}): string {
  return message.feedbackId ?? message.id;
}

function keysForAgentSlot(slot: { id: string; feedbackId?: string }): string[] {
  const keys = [reasoningExpandedMessageKey(slot), slot.id];
  if (slot.feedbackId !== undefined) keys.push(slot.feedbackId);
  return [...new Set(keys)];
}

/**
 * After composeChat remaps ids (turn ↔ mail), expanded prefs may still sit on a
 * stale alias in storage. Copy onto the canonical key and drop the alias.
 */
export function reconcileReasoningExpandedAliases(
  messages: readonly {
    role: string;
    id: string;
    feedbackId?: string;
    reasoning?: string;
  }[],
  storage: Storage = localStorage,
): boolean {
  let changed = false;
  for (const message of messages) {
    if (message.role !== "agent") continue;
    if ((message.reasoning ?? "").trim() === "") continue;
    const canonical = reasoningExpandedMessageKey(message);
    if (readReasoningExpanded(canonical, storage)) continue;
    for (const alias of keysForAgentSlot(message)) {
      if (alias === canonical) continue;
      if (readReasoningExpanded(alias, storage)) {
        writeReasoningExpanded(canonical, true, storage);
        clearReasoningExpanded(alias, storage);
        changed = true;
        break;
      }
    }
  }
  return changed;
}

/**
 * When the same transcript slot keeps one assistant reply but its display id
 * changes live (turn → mail before feedbackId is pinned), move expand prefs to
 * the new canonical key for that slot.
 */
export function migrateReasoningExpandedSlotKeys(
  previous: readonly { id: string; feedbackId?: string }[],
  current: readonly { id: string; feedbackId?: string }[],
  storage: Storage = localStorage,
): boolean {
  let changed = false;
  const slots = Math.min(previous.length, current.length);
  for (let i = 0; i < slots; i++) {
    const prev = previous[i];
    const curr = current[i];
    if (prev === undefined || curr === undefined) continue;
    const canonical = reasoningExpandedMessageKey(curr);
    if (readReasoningExpanded(canonical, storage)) continue;
    for (const key of keysForAgentSlot(prev)) {
      if (key === canonical) continue;
      if (readReasoningExpanded(key, storage)) {
        writeReasoningExpanded(canonical, true, storage);
        clearReasoningExpanded(key, storage);
        changed = true;
        break;
      }
    }
  }
  return changed;
}
