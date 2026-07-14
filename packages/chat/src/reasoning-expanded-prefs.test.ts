/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearReasoningExpanded,
  migrateReasoningExpandedSlotKeys,
  readReasoningExpanded,
  readReasoningExpandedForDisplay,
  reconcileReasoningExpandedAliases,
  reasoningExpandedMessageKey,
  writeReasoningExpanded,
} from "./reasoning-expanded-prefs";
import { MYRA_AGED_HISTORY_MS } from "./aged-history";

describe("reasoning-expanded-prefs", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = {
      _data: new Map<string, string>(),
      getItem(key: string) {
        return this._data.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this._data.set(key, value);
      },
      removeItem(key: string) {
        this._data.delete(key);
      },
      clear() {
        this._data.clear();
      },
      key() {
        return null;
      },
      get length() {
        return this._data.size;
      },
    } as Storage & { _data: Map<string, string> };
  });

  afterEach(() => {
    storage.clear();
  });

  it("defaults to collapsed when nothing is stored", () => {
    expect(readReasoningExpanded("m1", storage)).toBe(false);
  });

  it("persists expanded per message key", () => {
    writeReasoningExpanded("m1", true, storage);
    expect(readReasoningExpanded("m1", storage)).toBe(true);
    expect(readReasoningExpanded("m2", storage)).toBe(false);
  });

  it("clears collapsed state by removing the key", () => {
    writeReasoningExpanded("m1", true, storage);
    writeReasoningExpanded("m1", false, storage);
    expect(readReasoningExpanded("m1", storage)).toBe(false);
  });

  it("clearReasoningExpanded removes one key", () => {
    writeReasoningExpanded("m1", true, storage);
    writeReasoningExpanded("m2", true, storage);
    clearReasoningExpanded("m1", storage);
    expect(readReasoningExpanded("m1", storage)).toBe(false);
    expect(readReasoningExpanded("m2", storage)).toBe(true);
  });

  it("reasoningExpandedMessageKey prefers feedbackId", () => {
    expect(
      reasoningExpandedMessageKey({ id: "mail-a", feedbackId: "turn-t" }),
    ).toBe("turn-t");
    expect(reasoningExpandedMessageKey({ id: "turn-t" })).toBe("turn-t");
  });

  it("reconcileReasoningExpandedAliases moves mail id prefs onto feedbackId", () => {
    writeReasoningExpanded("mail-a", true, storage);
    const changed = reconcileReasoningExpandedAliases(
      [
        {
          role: "agent",
          id: "mail-a",
          feedbackId: "turn-t",
          reasoning: "Because",
        },
      ],
      storage,
    );
    expect(changed).toBe(true);
    expect(readReasoningExpanded("turn-t", storage)).toBe(true);
    expect(readReasoningExpanded("mail-a", storage)).toBe(false);
  });

  it("readReasoningExpandedForDisplay hides persisted expand on aged turns", () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const agedAt = new Date(now - MYRA_AGED_HISTORY_MS - 1).toISOString();
    writeReasoningExpanded("m1", true, storage);
    expect(readReasoningExpandedForDisplay("m1", agedAt, storage, now)).toBe(
      false,
    );
    const freshAt = new Date(now - 60_000).toISOString();
    expect(readReasoningExpandedForDisplay("m1", freshAt, storage, now)).toBe(
      true,
    );
  });

  it("migrateReasoningExpandedSlotKeys moves prefs when the slot id changes", () => {
    writeReasoningExpanded("turn-t", true, storage);
    const changed = migrateReasoningExpandedSlotKeys(
      [{ id: "turn-t" }],
      [{ id: "mail-a" }],
      storage,
    );
    expect(changed).toBe(true);
    expect(readReasoningExpanded("mail-a", storage)).toBe(true);
    expect(readReasoningExpanded("turn-t", storage)).toBe(false);
  });
});