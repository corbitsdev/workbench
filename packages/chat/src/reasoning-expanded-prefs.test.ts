/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearReasoningExpanded,
  readReasoningExpanded,
  writeReasoningExpanded,
} from "./reasoning-expanded-prefs";

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
});