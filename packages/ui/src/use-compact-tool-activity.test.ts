import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useCompactToolActivity } from "./use-compact-tool-activity";

const STORAGE_KEY = "cw-compact-tools";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useCompactToolActivity", () => {
  it("defaults to off and does NOT write the default to storage on mount", () => {
    const { result } = renderHook(() => useCompactToolActivity());
    expect(result.current.compact).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('reads a persisted "true" value on init', () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useCompactToolActivity());
    expect(result.current.compact).toBe(true);
  });

  it('treats any non-"true" stored value as off', () => {
    localStorage.setItem(STORAGE_KEY, "yes");
    const { result } = renderHook(() => useCompactToolActivity());
    expect(result.current.compact).toBe(false);
  });

  it("persists when toggled on and back off", () => {
    const { result } = renderHook(() => useCompactToolActivity());
    act(() => result.current.setCompact(true));
    expect(result.current.compact).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    act(() => result.current.setCompact(false));
    expect(result.current.compact).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
  });
});
